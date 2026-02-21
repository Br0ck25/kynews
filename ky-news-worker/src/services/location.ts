import kyCounties from "../data/ky-counties.json";
import kyCityCounty from "../data/ky-city-county.json";

function norm(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const KY_COUNTY_PATTERNS = (() => {
  const names = (kyCounties as Array<{ name: string }>).map((c) => c.name).filter(Boolean);
  names.sort((a, b) => b.length - a.length);

  return names.map((name) => {
    const n = norm(name);
    const re = new RegExp(`\\b${n.replace(/\s+/g, "\\s+")}\\s+(county|co\\.?)(\\b|\\s|,|\\.)`, "i");
    return { name, re };
  });
})();

const KY_CITY_PATTERNS = (() => {
  const rows = Array.isArray(kyCityCounty) ? (kyCityCounty as Array<{ city: string; county: string }>) : [];
  const cities = rows
    .map((r) => ({ city: String(r.city || "").trim(), county: String(r.county || "").trim() }))
    .filter((r) => r.city && r.county);

  cities.sort((a, b) => b.city.length - a.city.length);

  return cities.map(({ city, county }) => {
    const n = norm(city);
    const re = new RegExp(`\\b${n.replace(/\s+/g, "\\s+")}\\b`, "i");
    return { city, county, re };
  });
})();

const OTHER_STATE_NAME_PATTERNS = [
  "Alabama",
  "Alaska",
  "Arizona",
  "Arkansas",
  "California",
  "Colorado",
  "Connecticut",
  "Delaware",
  "Florida",
  "Georgia",
  "Hawaii",
  "Idaho",
  "Illinois",
  "Indiana",
  "Iowa",
  "Kansas",
  "Louisiana",
  "Maine",
  "Maryland",
  "Massachusetts",
  "Michigan",
  "Minnesota",
  "Mississippi",
  "Missouri",
  "Montana",
  "Nebraska",
  "Nevada",
  "New Hampshire",
  "New Jersey",
  "New Mexico",
  "New York",
  "North Carolina",
  "North Dakota",
  "Ohio",
  "Oklahoma",
  "Oregon",
  "Pennsylvania",
  "Rhode Island",
  "South Carolina",
  "South Dakota",
  "Tennessee",
  "Texas",
  "Utah",
  "Vermont",
  "Virginia",
  "Washington",
  "West Virginia",
  "Wisconsin",
  "Wyoming",
  "District of Columbia"
].map((name) => ({ name, re: new RegExp(`\\b${norm(name).replace(/\s+/g, "\\s+")}\\b`, "i") }));

export function detectOtherStateNames(text: string): string[] {
  const t = norm(text);
  if (!t) return [];
  const out: string[] = [];
  for (const { name, re } of OTHER_STATE_NAME_PATTERNS) {
    if (re.test(t)) out.push(name);
  }
  return Array.from(new Set(out));
}

export function detectKyCounties(text: string): string[] {
  const t = norm(text);
  if (!t) return [];

  const out: string[] = [];
  const raw = String(text || "");
  const hasKyContext = /\bkentucky\b/i.test(raw) || /\bky\b/i.test(raw);

  for (const { name, re } of KY_COUNTY_PATTERNS) {
    if (re.test(t)) out.push(name);
  }

  if (hasKyContext) {
    for (const { county, re } of KY_CITY_PATTERNS) {
      if (re.test(t)) out.push(county);
    }
  }

  return Array.from(new Set(out));
}

export function hasKySignal(text: string, counties: string[]): boolean {
  if (counties.length) return true;
  const raw = String(text || "");
  return /\bkentucky\b/i.test(raw) || /\bky\b/i.test(raw);
}
