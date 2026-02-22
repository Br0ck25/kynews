import kyCounties from "../../ingester/src/ky-counties.json" with { type: "json" };

const COUNTY_NAME_BY_NORMALIZED = new Map(
  (Array.isArray(kyCounties) ? kyCounties : [])
    .map((row) => String(row?.name || "").trim())
    .filter(Boolean)
    .map((name) => [
      name.toLowerCase().replace(/\s+county$/i, "").replace(/[^a-z0-9]+/g, " ").trim(),
      name
    ])
);

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
