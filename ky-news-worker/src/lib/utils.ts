import { decodeHtmlEntities, normalizeWhitespace, toHttpsUrl } from "./text";
import kyCounties from "../data/ky-counties.json";

export const NEWS_SCOPES = ["ky", "national", "all"] as const;
export const LOST_FOUND_TYPES = ["lost", "found"] as const;
export const LOST_FOUND_STATUSES = ["pending", "approved", "rejected", "published", "resolved"] as const;

const PAID_SOURCE_DOMAINS = [
  "bizjournals.com",
  "courier-journal.com",
  "dailyindependent.com",
  "franklinfavorite.com",
  "kentucky.com",
  "kentuckynewera.com",
  "messenger-inquirer.com",
  "news-expressky.com",
  "paducahsun.com",
  "richmondregister.com",
  "salyersvilleindependent.com",
  "state-journal.com",
  "thenewsenterprise.com",
  "timesleader.net"
];
const HEAVY_DEPRIORITIZED_PAID_DOMAINS = ["dailyindependent.com"];
const PAID_FALLBACK_LIMIT = 2;
const PAID_FALLBACK_WHEN_EMPTY_LIMIT = 3;
const MIN_ITEM_WORDS = 50;
const OUTPUT_NAV_CLUSTER_RE =
  /\b(?:home|news|sports|opinion|obituaries|features|classifieds|public notices|contests|calendar|services|about us|policies|news tip|submit photo|engagement announcement|wedding announcement|anniversary announcement|letter to editor|submit an obituary|pay subscription|e-edition)(?:\s+\b(?:home|news|sports|opinion|obituaries|features|classifieds|public notices|contests|calendar|services|about us|policies|news tip|submit photo|engagement announcement|wedding announcement|anniversary announcement|letter to editor|submit an obituary|pay subscription|e-edition)\b){4,}/gi;

const COUNTY_NAME_BY_NORMALIZED = new Map(
  (Array.isArray(kyCounties) ? (kyCounties as Array<{ name?: string }>) : [])
    .map((row) => String(row?.name || "").trim())
    .filter(Boolean)
    .map((name) => [
      name.toLowerCase().replace(/\s+county$/i, "").replace(/[^a-z0-9]+/g, " ").trim(),
      name
    ])
);

function sanitizeSummaryForOutput(input: unknown): string | null {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const cleaned = normalizeWhitespace(
    decodeHtmlEntities(raw)
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/`{1,3}/g, "")
  );
  return cleaned || null;
}

function sanitizeExcerptForOutput(input: unknown): string | null {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const cleaned = normalizeWhitespace(
    decodeHtmlEntities(raw)
      .replace(/\bYou are using an outdated browser[\s\S]{0,260}?experience\.\s*/gi, " ")
      .replace(/\bSubscribe\b[\s\S]{0,500}?\bE-Edition\b/gi, " ")
      .replace(OUTPUT_NAV_CLUSTER_RE, " ")
  );
  return cleaned || null;
}

export function csvToArray(csv: unknown): string[] {
  if (!csv) return [];
  return String(csv)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

export function mapItemRow<T extends Record<string, unknown>>(row: T): T & { states: string[]; counties: string[] } {
  const states = csvToArray(row.states_csv);
  const counties = csvToArray(row.counties_csv);
  const next = { ...row } as Record<string, unknown>;
  delete next.states_csv;
  delete next.counties_csv;
  const rawImageUrl = String(next.image_url || "").trim();
  if (rawImageUrl.startsWith("http://") || rawImageUrl.startsWith("//")) {
    next.image_url = toHttpsUrl(rawImageUrl);
  }
  if ("title" in next) {
    next.title = decodeHtmlEntities(String(next.title || "")).trim();
  }
  if ("author" in next) {
    const author = decodeHtmlEntities(String(next.author || "")).trim();
    next.author = author || null;
  }
  if ("summary" in next) {
    next.summary = sanitizeSummaryForOutput(next.summary);
  }
  if ("content" in next) {
    next.content = sanitizeExcerptForOutput(next.content);
  }
  return { ...(next as T), states, counties };
}

export function safeJsonParse<T>(input: unknown, fallback: T): T {
  try {
    if (typeof input !== "string") return fallback;
    return JSON.parse(input) as T;
  } catch {
    return fallback;
  }
}

export function normalizeCounty(county: unknown): string {
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

export function parseCountyList(input: unknown): string[] {
  if (!input) return [];
  const raw = Array.isArray(input) ? input : String(input).split(",");
  const out: string[] = [];
  for (const value of raw) {
    const county = normalizeCounty(value);
    if (!county) continue;
    if (!out.includes(county)) out.push(county);
  }
  return out;
}

export function isKy(stateCode: unknown): boolean {
  return String(stateCode || "").toUpperCase() === "KY";
}

export function sourceHost(url: unknown): string {
  try {
    return new URL(String(url || "")).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

export function canonicalUrl(url: unknown): string {
  try {
    const u = new URL(String(url || ""));
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_eid$|mkt_tok$)/i.test(key)) {
        u.searchParams.delete(key);
      }
    }
    u.hash = "";
    const pathname = u.pathname.replace(/\/+$/, "");
    u.pathname = pathname || "/";
    return u.toString();
  } catch {
    return "";
  }
}

export function titleFingerprint(title: unknown): string {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(the|a|an|and|or|for|to|of|in|on|at|from|with)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isPaidSource(url: unknown): boolean {
  const host = sourceHost(url);
  if (!host) return false;
  return PAID_SOURCE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

function countWords(input: unknown): number {
  return String(input || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function itemHasMinimumWords(item: Record<string, unknown>): boolean {
  const summaryWords = countWords(item.summary);
  const contentWords = countWords(item.content);
  return Math.max(summaryWords, contentWords) >= MIN_ITEM_WORDS;
}

function isHeavyDeprioritizedPaidSource(url: unknown): boolean {
  const host = sourceHost(url);
  if (!host) return false;
  return HEAVY_DEPRIORITIZED_PAID_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

type RankedItem = Record<string, unknown> & {
  id: string;
  title: string;
  url: string;
  sort_ts?: string;
};

export function rankAndFilterItems(items: RankedItem[], limit: number): RankedItem[] {
  const ranked = items.map((item) => ({
    ...item,
    _isPaid: isPaidSource(item.url),
    _isHeavyPaid: isHeavyDeprioritizedPaidSource(item.url),
    _fp: titleFingerprint(item.title),
    _canonicalUrl: canonicalUrl(item.url),
    _source: sourceHost(item.url),
    _sortTs: String(item.sort_ts || "")
  }));

  ranked.sort((a, b) => {
    if (a._isPaid !== b._isPaid) return a._isPaid ? 1 : -1;
    if (a._isHeavyPaid !== b._isHeavyPaid) return a._isHeavyPaid ? 1 : -1;
    return b._sortTs.localeCompare(a._sortTs);
  });

  const nonPaidFingerprints = new Set(ranked.filter((x) => !x._isPaid && x._fp).map((x) => x._fp));
  const seenTitle = new Set<string>();
  const seenCanonicalUrl = new Set<string>();
  const seenSourceTitle = new Set<string>();
  const filtered: typeof ranked = [];

  for (const item of ranked) {
    if (!itemHasMinimumWords(item)) continue;
    if (item._isPaid && item._fp && nonPaidFingerprints.has(item._fp)) continue;
    if (item._canonicalUrl && seenCanonicalUrl.has(item._canonicalUrl)) continue;
    if (item._fp && seenTitle.has(item._fp)) continue;
    const sourceTitleKey = item._fp ? `${item._fp}|${item._source}` : String(item.id);
    if (seenSourceTitle.has(sourceTitleKey)) continue;
    if (item._canonicalUrl) seenCanonicalUrl.add(item._canonicalUrl);
    if (item._fp) seenTitle.add(item._fp);
    seenSourceTitle.add(sourceTitleKey);
    filtered.push(item);
  }

  const nonPaid = filtered.filter((item) => !item._isPaid);
  const paid = filtered.filter((item) => item._isPaid && !item._isHeavyPaid);
  const heavyPaid = filtered.filter((item) => item._isHeavyPaid);
  const pickedNonPaid = nonPaid.slice(0, limit);
  const paidAllowance =
    pickedNonPaid.length === 0
      ? Math.min(limit, PAID_FALLBACK_WHEN_EMPTY_LIMIT)
      : Math.min(PAID_FALLBACK_LIMIT, Math.max(1, Math.floor(limit * 0.1)));
  const pickedPaid = paid.slice(0, paidAllowance);
  const heavyPaidAllowance = pickedNonPaid.length === 0 && pickedPaid.length === 0 ? Math.min(1, limit) : 0;
  const pickedHeavyPaid = heavyPaid.slice(0, heavyPaidAllowance);

  return [...pickedNonPaid, ...pickedPaid, ...pickedHeavyPaid]
    .slice(0, limit)
    .map(({ _isPaid, _isHeavyPaid, _fp, _canonicalUrl, _source, _sortTs, ...rest }) => rest as RankedItem);
}

export function isPrivateHost(hostname: unknown): boolean {
  const host = String(hostname || "").toLowerCase();
  if (!host) return true;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  if (host.startsWith("10.")) return true;
  if (host.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  return false;
}

export function stripExecutableHtml(html: unknown): string {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object[\s\S]*?<\/object>/gi, "")
    .replace(/<embed[\s\S]*?>/gi, "")
    .replace(/<link[^>]+rel=["'][^"']*stylesheet[^"']*["'][^>]*>/gi, "")
    .replace(/<meta[^>]+http-equiv=["']content-security-policy["'][^>]*>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "")
    .replace(/\son\w+='[^']*'/gi, "");
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function decodeCsvParam(values: string | string[] | undefined): string[] {
  if (!values) return [];
  return Array.isArray(values) ? values : [values];
}
