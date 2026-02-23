import kyCounties from "../../ingester/src/ky-counties.json" with { type: "json" };
import kyCityCounty from "../../ingester/src/ky-city-county.json" with { type: "json" };

const COUNTY_NAME_BY_NORMALIZED = new Map(
  (Array.isArray(kyCounties) ? kyCounties : [])
    .map((row) => String(row?.name || "").trim())
    .filter(Boolean)
    .map((name) => [
      name.toLowerCase().replace(/\s+county$/i, "").replace(/[^a-z0-9]+/g, " ").trim(),
      name
    ])
);

// FIX #7: Canonical location-text normalizer — single source of truth used by both
// ingester and API server (previously duplicated as norm() / normLocationText()).
export function normLocationText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// FIX #7: Canonical KY county patterns — exported so ingester and server share one copy.
export const KY_COUNTY_PATTERNS = (() => {
  const names = (kyCounties || []).map((c) => c.name).filter(Boolean);
  names.sort((a, b) => b.length - a.length);
  return names.map((name) => {
    const n = normLocationText(name);
    const re = new RegExp(`\\b${n.replace(/\s+/g, "\\s+")}\\s+(county|co\\.?)(\\b|\\s|,|\\.)`, "i");
    return { name, re };
  });
})();

// FIX #7: Canonical KY city→county patterns — exported for shared use.
export const KY_CITY_PATTERNS = (() => {
  const rows = Array.isArray(kyCityCounty) ? kyCityCounty : [];
  const cities = rows
    .map((r) => ({ city: String(r.city || "").trim(), county: String(r.county || "").trim() }))
    .filter((r) => r.city && r.county);
  cities.sort((a, b) => b.city.length - a.city.length);
  return cities.map(({ city, county }) => {
    const n = normLocationText(city);
    const re = new RegExp(`\\b${n.replace(/\s+/g, "\\s+")}\\b`, "i");
    return { city, county, re };
  });
})();

// Query-time county patterns — lenient (county word optional), used by search.
export const KY_QUERY_COUNTY_PATTERNS = (() => {
  const names = (kyCounties || []).map((c) => c.name).filter(Boolean);
  names.sort((a, b) => b.length - a.length);
  return names.map((name) => {
    const n = normLocationText(name);
    const re = new RegExp(`\\b${n.replace(/\s+/g, "\\s+")}(?:\\s+(?:county|co\\.?))?\\b`, "i");
    return { name, re };
  });
})();

const OTHER_STATE_NAME_PATTERNS_LIST = [
  "Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut",
  "Delaware","Florida","Georgia","Hawaii","Idaho","Illinois","Indiana","Iowa",
  "Kansas","Louisiana","Maine","Maryland","Massachusetts","Michigan","Minnesota",
  "Mississippi","Missouri","Montana","Nebraska","Nevada","New Hampshire","New Jersey",
  "New Mexico","New York","North Carolina","North Dakota","Ohio","Oklahoma","Oregon",
  "Pennsylvania","Rhode Island","South Carolina","South Dakota","Tennessee","Texas",
  "Utah","Vermont","Virginia","Washington","West Virginia","Wisconsin","Wyoming",
  "District of Columbia"
];

// FIX #7: Canonical other-state detector — exported for shared use.
export const OTHER_STATE_NAME_PATTERNS = OTHER_STATE_NAME_PATTERNS_LIST.map((name) => ({
  name,
  re: new RegExp(`\\b${normLocationText(name).replace(/\s+/g, "\\s+")}\\b`, "i")
}));

// FIX #7: Exported canonical implementation — previously duplicated in ingester.mjs and server.mjs.
export function detectOtherStateNames(text) {
  const t = normLocationText(text);
  if (!t) return [];
  const out = [];
  for (const { name, re } of OTHER_STATE_NAME_PATTERNS) {
    if (re.test(t)) out.push(name);
  }
  return Array.from(new Set(out));
}

// FIX #7: Exported canonical implementation — previously duplicated in both apps.
// City matching only fires when explicit Kentucky context is present to avoid false positives.
export function detectKyCounties(text) {
  const t = normLocationText(text);
  if (!t) return [];
  const out = [];
  const raw = String(text || "");
  const hasKyContext = /\bkentucky\b/i.test(raw) || /\bky\b/i.test(raw);

  for (const { name, re } of KY_COUNTY_PATTERNS) {
    if (re.test(t)) out.push(name);
  }

  // FIX #7: City names are ambiguous across states; require explicit Kentucky context.
  if (hasKyContext) {
    for (const { county, re } of KY_CITY_PATTERNS) {
      if (re.test(t)) out.push(county);
    }
  }

  return Array.from(new Set(out));
}

// FIX #7: Exported canonical implementation.
export function hasKySignal(text, counties) {
  if (counties.length) return true;
  const raw = String(text || "");
  return /\bkentucky\b/i.test(raw) || /\bky\b/i.test(raw);
}

// Query-time county detection (lenient — county word optional, city names used without KY context).
export function detectKyQueryCounties(text) {
  const t = normLocationText(text);
  if (!t) return [];
  const out = [];
  for (const { name, re } of KY_QUERY_COUNTY_PATTERNS) {
    if (re.test(t)) out.push(name);
  }
  for (const { city, county, re } of KY_CITY_PATTERNS) {
    if (city.length < 4) continue;
    if (re.test(t)) out.push(county);
  }
  return Array.from(new Set(out));
}

export function csvToArray(csv) {
  if (!csv) return [];
  return String(csv)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

export function mapItemRow(row) {
  const states = csvToArray(row.states_csv);
  const counties = csvToArray(row.counties_csv);
  const { states_csv, counties_csv, ...rest } = row;
  return { ...rest, states, counties };
}

export function escapeLike(input) {
  return String(input).replace(/[\\%_]/g, "\\$&");
}

export function parseSearchQuery(input) {
  const q = String(input || "");
  const tokens = [];
  let i = 0;

  while (i < q.length) {
    while (i < q.length && /\s/.test(q[i])) i++;
    if (i >= q.length) break;

    let negated = false;
    if (q[i] === "-") {
      negated = true;
      i++;
      while (i < q.length && /\s/.test(q[i])) i++;
    }

    if (i >= q.length) break;

    let value = "";
    let quoted = false;
    if (q[i] === '"') {
      quoted = true;
      i++;
      const start = i;
      while (i < q.length && q[i] !== '"') i++;
      value = q.slice(start, i);
      if (i < q.length && q[i] === '"') i++;
    } else {
      const start = i;
      while (i < q.length && !/\s/.test(q[i])) i++;
      value = q.slice(start, i);
    }

    value = value.trim();
    if (!value) continue;

    if (!quoted && !negated) {
      const upper = value.toUpperCase();
      if (upper === "AND" || upper === "OR") {
        tokens.push({ kind: "op", op: upper });
        continue;
      }
    }

    tokens.push({ kind: "term", value, negated });
  }

  const groups = [{ include: [], exclude: [] }];
  for (const token of tokens) {
    const current = groups[groups.length - 1];
    if (token.kind === "op") {
      if (token.op === "OR") {
        if (current.include.length || current.exclude.length) groups.push({ include: [], exclude: [] });
      }
      continue;
    }

    if (token.negated) current.exclude.push(token.value);
    else current.include.push(token.value);
  }

  return groups.filter((g) => g.include.length || g.exclude.length);
}

export function buildSearchClause(rawQuery, params) {
  const searchableDoc = "LOWER(COALESCE(i.title, '') || ' ' || COALESCE(i.summary, '') || ' ' || COALESCE(i.content, ''))";
  const groups = parseSearchQuery(rawQuery);
  if (!groups.length) return "1=0";

  const orBlocks = groups.map((g, gIdx) => {
    const andParts = [];

    for (let i = 0; i < g.include.length; i++) {
      const key = `q_i_${gIdx}_${i}`;
      params[key] = `%${escapeLike(g.include[i].toLowerCase())}%`;
      andParts.push(`${searchableDoc} LIKE @${key} ESCAPE '\\'`);
    }

    for (let i = 0; i < g.exclude.length; i++) {
      const key = `q_x_${gIdx}_${i}`;
      params[key] = `%${escapeLike(g.exclude[i].toLowerCase())}%`;
      andParts.push(`${searchableDoc} NOT LIKE @${key} ESCAPE '\\'`);
    }

    if (!andParts.length) return null;
    return `(${andParts.join(" AND ")})`;
  });

  const filtered = orBlocks.filter(Boolean);
  if (!filtered.length) return "1=0";
  return `(${filtered.join(" OR ")})`;
}

export function normalizeCounty(county) {
  const base = String(county || "")
    .trim()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+county$/i, "")
    .trim();
  if (!base) return "";

  const key = base.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return COUNTY_NAME_BY_NORMALIZED.get(key) || base;
}

export function isKy(stateCode) {
  return String(stateCode || "").toUpperCase() === "KY";
}

export function safeJsonParse(input, fallback) {
  try {
    return JSON.parse(input);
  } catch {
    return fallback;
  }
}
