import kyCounties from "./ky-counties.json";

type CountyRow = { name?: string };

const COUNTY_NAMES = (kyCounties as CountyRow[])
  .map((row) => String(row?.name || "").trim())
  .filter(Boolean);

const COUNTY_NAME_BY_LOWER = new Map(COUNTY_NAMES.map((name) => [name.toLowerCase(), name]));
const COUNTY_NAME_BY_SLUG = new Map(COUNTY_NAMES.map((name) => [countyNameToSlug(name), name]));

function normalizeCountyName(value: string): string {
  return String(value || "")
    .trim()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+county$/i, "");
}

function titleCaseWords(value: string): string {
  return value
    .split(" ")
    .map((word) => word.trim())
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

export function countyNameToSlug(name: string): string {
  const normalized = normalizeCountyName(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) return "";
  return `${normalized}-county`;
}

export function countySlugToName(slug: string): string | null {
  const normalizedSlug = String(slug || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalizedSlug) return null;

  const exact = COUNTY_NAME_BY_SLUG.get(normalizedSlug);
  if (exact) return exact;

  const base = normalizedSlug.replace(/-county$/i, "");
  if (!base) return null;

  const guessedName = titleCaseWords(base.replace(/-/g, " "));
  const canonicalGuess = COUNTY_NAME_BY_LOWER.get(guessedName.toLowerCase());
  if (canonicalGuess) return canonicalGuess;

  const canonicalBySlug = COUNTY_NAME_BY_SLUG.get(countyNameToSlug(guessedName));
  return canonicalBySlug || null;
}

export function countySlugToDisplayName(slug: string): string {
  const known = countySlugToName(slug);
  if (known) return known;
  const cleaned = String(slug || "")
    .trim()
    .replace(/-county$/i, "")
    .replace(/-/g, " ");
  const title = titleCaseWords(cleaned);
  return title || "Kentucky";
}
