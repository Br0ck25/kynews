import type { ParsedFeedItem } from "./rss";
import { decodeHtmlEntities, normalizeWhitespace, toHttpsUrl } from "../lib/text";
import { logWarn } from "../lib/logger";

const LIST_TIMEOUT_MS = 15_000;
const META_TIMEOUT_MS = 9_000;
const LIST_MAX_CHARS = 2_000_000;
const META_MAX_CHARS = 1_200_000;
const MAX_META_FETCHES = 16;
const META_CONCURRENCY = 4;
const MIN_TITLE_CHARS = 12;

type ScraperKind = "generic-news" | "gannett-story" | "townnews-article" | "mcclatchy-article";

export type ScrapeFeedInput = {
  feedId: string;
  /** Display name of the feed (used as post title for facebook-page mode). */
  feedName?: string;
  url: string;
  scraperId: string | null;
  maxItems: number;
  userAgent: string;
  /**
   * Optional Facebook session cookie (xs, c_user, datr, etc.) to authenticate
   * mbasic.facebook.com requests when the page requires login.
   * Configure via FACEBOOK_SESSION_COOKIE env var in wrangler.jsonc secrets.
   */
  sessionCookie?: string;
};

export type ScrapeFeedResult = {
  status: number;
  items: ParsedFeedItem[];
};

type Candidate = {
  link: string;
  title: string;
  isoDate: string | null;
  snippet: string | null;
  imageUrl: string | null;
  author: string | null;
  score: number;
};

type ArticleMeta = {
  title: string | null;
  snippet: string | null;
  isoDate: string | null;
  author: string | null;
  imageUrl: string | null;
  canonicalUrl: string | null;
};

const SCRAPER_BY_ID: Record<string, ScraperKind> = {
  "generic-news": "generic-news",
  "gannett-story": "gannett-story",
  "townnews-article": "townnews-article",
  "mcclatchy-article": "mcclatchy-article"
};

const HOST_SCRAPER_HINTS: Array<{ host: string; kind: ScraperKind }> = [
  { host: "courier-journal.com", kind: "gannett-story" },
  { host: "cincinnati.com", kind: "gannett-story" },
  { host: "messenger-inquirer.com", kind: "townnews-article" },
  { host: "paducahsun.com", kind: "townnews-article" },
  { host: "kentuckynewera.com", kind: "townnews-article" },
  { host: "hazard-herald.com", kind: "townnews-article" },
  { host: "dailyindependent.com", kind: "townnews-article" },
  { host: "state-journal.com", kind: "townnews-article" },
  // Added: additional TownNews CMS papers switched to scrape mode
  { host: "richmondregister.com", kind: "townnews-article" },
  { host: "floydct.com", kind: "townnews-article" },
  { host: "news-expressky.com", kind: "townnews-article" },
  { host: "thenewsenterprise.com", kind: "townnews-article" },
  { host: "kentucky.com", kind: "mcclatchy-article" }
];

const META_PATTERNS = {
  ogTitle: /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i,
  twTitle: /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["'][^>]*>/i,
  description: /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i,
  ogDescription: /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["'][^>]*>/i,
  author: /<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["'][^>]*>/i,
  articleAuthor: /<meta[^>]+property=["']article:author["'][^>]+content=["']([^"']+)["'][^>]*>/i,
  published: /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["'][^>]*>/i,
  ogImage: /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
  canonical: /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/i,
  title: /<title[^>]*>([\s\S]*?)<\/title>/i,
  timeTag: /<time[^>]+datetime=["']([^"']+)["'][^>]*>/i
};

const LINK_ATTR_RE = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
const LINK_URL_RE = /https?:\/\/[^\s"'<>]+/gi;
const SCRIPT_JSONLD_RE = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

function toIsoOrNull(input: string | null | undefined): string | null {
  if (!input) return null;
  const dt = new Date(input);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

function cleanText(input: string | null | undefined): string {
  return normalizeWhitespace(
    decodeHtmlEntities(String(input || ""))
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
  );
}

function cleanTitle(input: string | null | undefined): string {
  return cleanText(input).replace(/\s+\|\s+.*$/, "").trim();
}

function extractFirst(html: string, pattern: RegExp): string | null {
  const match = html.match(pattern);
  const raw = match?.[1]?.trim();
  if (!raw) return null;
  return decodeHtmlEntities(raw).trim() || null;
}

function decodePossiblyEscaped(input: string): string {
  const decoded = decodeHtmlEntities(input);
  try {
    return JSON.parse(`"${decoded.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  } catch {
    return decoded;
  }
}

function canonicalizeUrl(rawUrl: string, baseUrl: string): string | null {
  try {
    const absolute = new URL(rawUrl, baseUrl);
    if (absolute.protocol === "http:") absolute.protocol = "https:";
    if (absolute.protocol !== "https:") return null;
    absolute.hash = "";
    for (const key of [...absolute.searchParams.keys()]) {
      if (/^(utm_|gclid$|fbclid$|mc_eid$|mkt_tok$|outputType$|output$)/i.test(key)) {
        absolute.searchParams.delete(key);
      }
    }
    const path = absolute.pathname.replace(/\/+$/, "");
    absolute.pathname = path || "/";
    return absolute.toString();
  } catch {
    return null;
  }
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, "");
}

function hostMatches(urlHost: string, sourceHost: string): boolean {
  const a = normalizeHost(urlHost);
  const b = normalizeHost(sourceHost);
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function resolveScraperKind(feedUrl: string, scraperId: string | null): ScraperKind {
  const explicit = scraperId ? SCRAPER_BY_ID[scraperId.trim().toLowerCase()] : null;
  if (explicit) return explicit;

  try {
    const host = normalizeHost(new URL(feedUrl).hostname);
    const matched = HOST_SCRAPER_HINTS.find((entry) => host === entry.host || host.endsWith(`.${entry.host}`));
    if (matched) return matched.kind;
  } catch {
    // Ignore and use generic fallback.
  }

  return "generic-news";
}

function scoreCandidate(kind: ScraperKind, url: URL, title: string): number {
  const path = `${url.pathname}${url.search}`.toLowerCase();
  let score = 0;

  if (title.length >= MIN_TITLE_CHARS) score += Math.min(20, Math.floor(title.length / 8));
  if (/\/20\d{2}\/\d{2}\/\d{2}\//.test(path)) score += 20;
  if (/\/(news|local|state|politics|business|education|sports|weather|obituaries|crime|government)\//.test(path)) {
    score += 24;
  }
  if ((path.match(/\//g) || []).length >= 4) score += 10;

  if (kind === "gannett-story") {
    if (/\/story\//.test(path)) score += 80;
    else score -= 35;
  } else if (kind === "townnews-article") {
    if (/article_[a-z0-9-]+\.html/.test(path)) score += 85;
    else score -= 30;
  } else if (kind === "mcclatchy-article") {
    if (/\/article\d+\.html/.test(path)) score += 85;
    else if (/\/news\//.test(path) && /\.html/.test(path)) score += 40;
    else score -= 25;
  } else {
    if (/\/story\//.test(path) || /article_[a-z0-9-]+\.html/.test(path) || /\/article\d+\.html/.test(path)) {
      score += 55;
    }
  }

  if (/\.(jpg|jpeg|png|gif|svg|webp|pdf)$/i.test(path)) score -= 250;
  if (/\/(video|videos|photos?|galleries?|podcasts?)\//.test(path)) score -= 35;
  if (/\/(tag|tags|topic|topics|author|authors|about|contact|privacy|terms|sitemap|account|subscribe)\b/.test(path)) {
    score -= 140;
  }
  if (/\/ap\//.test(path)) score -= 25;
  if (/\/search\//.test(path)) score -= 60;
  if (url.searchParams.has("output") || url.searchParams.has("outputType")) score -= 20;

  return score;
}

function isLikelyArticleCandidate(kind: ScraperKind, url: URL, sourceHost: string): boolean {
  if (!hostMatches(url.hostname, sourceHost)) return false;
  const path = `${url.pathname}${url.search}`.toLowerCase();
  if (!path || path === "/" || path.length < 8) return false;
  if (/\.(jpg|jpeg|png|gif|svg|webp|pdf)$/i.test(path)) return false;
  if (/#/.test(path)) return false;
  if (/\/(subscribe|account|login|privacy|terms|contact|about|staff|sitemap)\b/.test(path)) return false;

  if (kind === "gannett-story") return /\/story\//.test(path);
  if (kind === "townnews-article") {
    return /article_[a-z0-9-]+\.html/.test(path) && !/\/ap\//.test(path);
  }
  if (kind === "mcclatchy-article") return /\/article\d+\.html/.test(path) || (/\/news\//.test(path) && /\.html/.test(path));

  return /\/story\//.test(path) || /article_[a-z0-9-]+\.html/.test(path) || /\/article\d+\.html/.test(path) || /\/20\d{2}\//.test(path);
}

function parseJsonLdBlock(raw: string): unknown | null {
  const stripped = raw.trim().replace(/^<!--/, "").replace(/-->$/, "").trim();
  if (!stripped) return null;
  try {
    return JSON.parse(stripped);
  } catch {
    try {
      return JSON.parse(decodePossiblyEscaped(stripped));
    } catch {
      return null;
    }
  }
}

function walkJson(value: unknown, fn: (node: Record<string, unknown>) => void, depth = 0): void {
  if (depth > 8 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, fn, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  const node = value as Record<string, unknown>;
  fn(node);

  for (const key of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement", "hasPart", "about"]) {
    if (key in node) walkJson(node[key], fn, depth + 1);
  }
}

function readJsonUrl(node: Record<string, unknown>): string | null {
  const direct = node.url;
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const id = node["@id"];
  if (typeof id === "string" && id.trim()) return id.trim();

  const mainEntity = node.mainEntity as Record<string, unknown> | undefined;
  if (mainEntity && typeof mainEntity === "object") {
    const nested = readJsonUrl(mainEntity);
    if (nested) return nested;
  }

  const item = node.item as Record<string, unknown> | undefined;
  if (item && typeof item === "object") {
    const nested = readJsonUrl(item);
    if (nested) return nested;
  }

  return null;
}

function readJsonImage(node: Record<string, unknown>): string | null {
  const image = node.image;
  if (typeof image === "string") return image;
  if (Array.isArray(image)) {
    const first = image.find((entry) => typeof entry === "string") as string | undefined;
    if (first) return first;
    const obj = image.find((entry) => entry && typeof entry === "object") as Record<string, unknown> | undefined;
    if (obj && typeof obj.url === "string") return obj.url;
  }
  if (image && typeof image === "object" && typeof (image as Record<string, unknown>).url === "string") {
    return String((image as Record<string, unknown>).url);
  }
  return null;
}

function readJsonAuthor(node: Record<string, unknown>): string | null {
  const author = node.author;
  if (typeof author === "string") return cleanText(author);
  if (Array.isArray(author)) {
    for (const entry of author) {
      if (typeof entry === "string") {
        const cleaned = cleanText(entry);
        if (cleaned) return cleaned;
      }
      if (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).name === "string") {
        const cleaned = cleanText(String((entry as Record<string, unknown>).name));
        if (cleaned) return cleaned;
      }
    }
  }
  if (author && typeof author === "object" && typeof (author as Record<string, unknown>).name === "string") {
    return cleanText(String((author as Record<string, unknown>).name));
  }
  return null;
}

function candidateFromJsonLd(node: Record<string, unknown>, baseUrl: string, kind: ScraperKind, sourceHost: string): Candidate | null {
  const typeRaw = node["@type"];
  const types = Array.isArray(typeRaw) ? typeRaw.map((v) => String(v || "").toLowerCase()) : [String(typeRaw || "").toLowerCase()];

  const isArticle =
    types.some((t) =>
      [
        "newsarticle",
        "article",
        "reportagenewsarticle",
        "blogposting",
        "liveblogposting",
        "analysisnewsarticle"
      ].includes(t)
    ) || types.some((t) => t.includes("article"));

  if (!isArticle && !types.includes("itemlist")) return null;

  if (types.includes("itemlist")) {
    return null;
  }

  const linkRaw = readJsonUrl(node);
  if (!linkRaw) return null;
  const link = canonicalizeUrl(linkRaw, baseUrl);
  if (!link) return null;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(link);
  } catch {
    return null;
  }

  if (!isLikelyArticleCandidate(kind, parsedUrl, sourceHost)) return null;

  const title = cleanTitle(String(node.headline || node.name || ""));
  if (title.length < MIN_TITLE_CHARS) return null;

  return {
    link,
    title,
    isoDate: toIsoOrNull(String(node.datePublished || node.dateCreated || node.dateModified || "")),
    snippet: cleanText(String(node.description || "")) || null,
    imageUrl: toHttpsUrl(readJsonImage(node)),
    author: readJsonAuthor(node),
    score: scoreCandidate(kind, parsedUrl, title) + 15
  };
}

function extractJsonLdCandidates(html: string, baseUrl: string, kind: ScraperKind, sourceHost: string): Candidate[] {
  const out: Candidate[] = [];

  for (const match of html.matchAll(SCRIPT_JSONLD_RE)) {
    const raw = String(match[1] || "").trim();
    if (!raw) continue;

    const parsed = parseJsonLdBlock(raw);
    if (!parsed) continue;

    walkJson(parsed, (node) => {
      const candidate = candidateFromJsonLd(node, baseUrl, kind, sourceHost);
      if (candidate) out.push(candidate);

      const typeRaw = node["@type"];
      const types = Array.isArray(typeRaw) ? typeRaw.map((v) => String(v || "").toLowerCase()) : [String(typeRaw || "").toLowerCase()];
      if (!types.includes("itemlist")) return;

      const items = node.itemListElement;
      if (!Array.isArray(items)) return;
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const entry = item as Record<string, unknown>;
        const urlRaw = readJsonUrl(entry);
        if (!urlRaw) continue;
        const link = canonicalizeUrl(urlRaw, baseUrl);
        if (!link) continue;
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(link);
        } catch {
          continue;
        }
        if (!isLikelyArticleCandidate(kind, parsedUrl, sourceHost)) continue;

        const title = cleanTitle(String(entry.name || entry.headline || ""));
        if (title.length < MIN_TITLE_CHARS) continue;

        out.push({
          link,
          title,
          isoDate: toIsoOrNull(String(entry.datePublished || entry.dateCreated || "")),
          snippet: cleanText(String(entry.description || "")) || null,
          imageUrl: toHttpsUrl(readJsonImage(entry)),
          author: readJsonAuthor(entry),
          score: scoreCandidate(kind, parsedUrl, title) + 10
        });
      }
    });
  }

  return out;
}

function extractAnchorCandidates(html: string, baseUrl: string, kind: ScraperKind, sourceHost: string): Candidate[] {
  const out: Candidate[] = [];

  for (const match of html.matchAll(LINK_ATTR_RE)) {
    const href = String(match[1] || match[2] || match[3] || "").trim();
    const link = canonicalizeUrl(href, baseUrl);
    if (!link) continue;

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(link);
    } catch {
      continue;
    }

    if (!isLikelyArticleCandidate(kind, parsedUrl, sourceHost)) continue;

    const title = cleanTitle(String(match[4] || ""));
    if (title.length < MIN_TITLE_CHARS) continue;

    const score = scoreCandidate(kind, parsedUrl, title);
    if (score < 30) continue;

    out.push({
      link,
      title,
      isoDate: null,
      snippet: null,
      imageUrl: null,
      author: null,
      score
    });
  }

  return out;
}

function extractLooseUrlCandidates(html: string, baseUrl: string, kind: ScraperKind, sourceHost: string): Candidate[] {
  const out: Candidate[] = [];
  for (const match of html.matchAll(LINK_URL_RE)) {
    const link = canonicalizeUrl(match[0], baseUrl);
    if (!link) continue;

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(link);
    } catch {
      continue;
    }

    if (!isLikelyArticleCandidate(kind, parsedUrl, sourceHost)) continue;

    const derivedTitle = cleanTitle(
      parsedUrl.pathname
        .split("/")
        .filter(Boolean)
        .slice(-2)
        .join(" ")
        .replace(/[-_]/g, " ")
    );
    if (derivedTitle.length < MIN_TITLE_CHARS) continue;

    const score = scoreCandidate(kind, parsedUrl, derivedTitle) - 8;
    if (score < 30) continue;

    out.push({
      link,
      title: derivedTitle,
      isoDate: null,
      snippet: null,
      imageUrl: null,
      author: null,
      score
    });
  }
  return out;
}

function mergeCandidates(candidates: Candidate[]): Candidate[] {
  const map = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const key = candidate.link;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, candidate);
      continue;
    }

    map.set(key, {
      link: key,
      title: prev.title.length >= candidate.title.length ? prev.title : candidate.title,
      isoDate: prev.isoDate || candidate.isoDate,
      snippet: prev.snippet || candidate.snippet,
      imageUrl: prev.imageUrl || candidate.imageUrl,
      author: prev.author || candidate.author,
      score: Math.max(prev.score, candidate.score)
    });
  }

  return [...map.values()].sort((a, b) => b.score - a.score);
}

function listingFallbackPaths(kind: ScraperKind): string[] {
  if (kind === "gannett-story") return ["/news/", "/news/local/", "/news/politics/"];
  if (kind === "townnews-article") return ["/news/", "/sports/", "/obituaries/"];
  if (kind === "mcclatchy-article") return ["/news/", "/news/politics-government/"];
  return ["/news/"];
}

function buildListingUrls(feedUrl: string, kind: ScraperKind): string[] {
  const out = new Set<string>();
  const primary = canonicalizeUrl(feedUrl, feedUrl);
  if (primary) out.add(primary);

  let origin: string | null = null;
  try {
    const base = new URL(feedUrl);
    origin = `${base.protocol}//${base.host}`;
  } catch {
    origin = null;
  }

  if (origin) {
    for (const path of listingFallbackPaths(kind)) {
      const combined = canonicalizeUrl(path, origin);
      if (combined) out.add(combined);
      if (out.size >= 3) break;
    }
  }

  return [...out];
}

async function fetchHtml(
  url: string,
  userAgent: string,
  timeoutMs: number,
  maxChars: number
): Promise<{ status: number; html: string; finalUrl: string }> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "user-agent": userAgent,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        pragma: "no-cache"
      },
      cf: { cacheTtl: 0 }
    });

    const status = response.status;
    if (status < 200 || status >= 300) {
      throw new Error(`HTTP ${status} from ${url}`);
    }

    let html = await response.text();
    if (html.length > maxChars) html = html.slice(0, maxChars);
    return { status, html, finalUrl: response.url || url };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchArticleMeta(url: string, userAgent: string): Promise<ArticleMeta | null> {
  try {
    const fetched = await fetchHtml(url, userAgent, META_TIMEOUT_MS, META_MAX_CHARS);
    const html = fetched.html;

    const title = cleanTitle(extractFirst(html, META_PATTERNS.ogTitle) || extractFirst(html, META_PATTERNS.twTitle) || extractFirst(html, META_PATTERNS.title) || "");
    const snippet =
      cleanText(extractFirst(html, META_PATTERNS.ogDescription) || extractFirst(html, META_PATTERNS.description) || "") ||
      null;
    const isoDate = toIsoOrNull(extractFirst(html, META_PATTERNS.published) || extractFirst(html, META_PATTERNS.timeTag) || "");
    const author = cleanText(extractFirst(html, META_PATTERNS.author) || extractFirst(html, META_PATTERNS.articleAuthor) || "") || null;
    const imageUrl = toHttpsUrl(extractFirst(html, META_PATTERNS.ogImage));
    const canonicalUrl = canonicalizeUrl(extractFirst(html, META_PATTERNS.canonical) || fetched.finalUrl, fetched.finalUrl);

    return {
      title: title || null,
      snippet,
      isoDate,
      author,
      imageUrl,
      canonicalUrl
    };
  } catch {
    return null;
  }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return [];
  const max = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: max }, () => worker()));
  return results;
}

function toParsedFeedItem(candidate: Candidate): ParsedFeedItem {
  return {
    title: candidate.title || "(untitled)",
    link: candidate.link,
    guid: candidate.link,
    isoDate: candidate.isoDate,
    pubDate: candidate.isoDate,
    contentSnippet: candidate.snippet,
    content: candidate.snippet,
    author: candidate.author,
    imageUrl: candidate.imageUrl
  };
}

// ─── Facebook public-page scraper ───────────────────────────────────────────
/**
 * Scrape a public Facebook page via mbasic.facebook.com (server-rendered, no JS required).
 * Returns posts as feed items: page name = title, post text = content, first image = imageUrl.
 * No minimum word count is enforced – school/community posts are typically short.
 *
 * Falls back gracefully (returns 0 items) when Facebook blocks the request or
 * requires login.
 */
export async function scrapeFacebookPageItems(input: ScrapeFeedInput): Promise<ScrapeFeedResult> {
  // Extract page slug from Facebook URL (https://www.facebook.com/{slug}/)
  let pageSlug = "";
  let numericId = false;
  try {
    const u = new URL(input.url);
    const firstSegment = u.pathname.replace(/^\/+/, "").split("/")[0] || "";
    pageSlug = firstSegment;
    numericId = /^\d+$/.test(pageSlug);
  } catch {
    throw new Error(`Invalid Facebook page URL: ${input.url}`);
  }

  if (!pageSlug) {
    throw new Error(`Could not extract page slug from Facebook URL: ${input.url}`);
  }

  // Use mbasic (server-rendered, no JS) for public pages
  const mbasicUrl = numericId
    ? `https://mbasic.facebook.com/profile.php?id=${pageSlug}`
    : `https://mbasic.facebook.com/${pageSlug}`;

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), LIST_TIMEOUT_MS);

  let html = "";
  let status = 0;
  try {
    const reqHeaders: Record<string, string> = {
      // Mobile Safari UA encourages mbasic rendering path
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
    };
    // Include session cookie if configured — required for pages that Facebook
    // has restricted to logged-in users. Configure FACEBOOK_SESSION_COOKIE in env.
    if (input.sessionCookie) {
      reqHeaders["Cookie"] = input.sessionCookie;
    }
    const res = await fetch(mbasicUrl, {
      signal: ctrl.signal,
      headers: reqHeaders,
      redirect: "follow",
    });
    status = res.status;
    if (status === 200) {
      html = await res.text();
      if (html.length > LIST_MAX_CHARS) html = html.slice(0, LIST_MAX_CHARS);
    }
  } finally {
    clearTimeout(timeout);
  }

  if (status !== 200) {
    // Non-200 is a soft failure — log and return empty rather than throwing,
    // so one blocked page doesn't abort the entire ingest run.
    logWarn("ingest.facebook.http_error", {
      feedId: input.feedId,
      url: mbasicUrl,
      status
    });
    return { status, items: [] };
  }

  // Detect login-wall redirect (Facebook blocks unauthenticated bots for some pages)
  const isLoginPage =
    html.includes('id="login_form"') ||
    (html.includes('name="email"') && html.includes('name="pass"')) ||
    html.includes("/login/?next=");
  if (isLoginPage) {
    // Return gracefully instead of throwing — if no session cookie is configured,
    // all Facebook feeds would otherwise error out on every ingest cycle.
    // To restore Facebook content: set FACEBOOK_SESSION_COOKIE in wrangler secrets.
    logWarn("ingest.facebook.login_wall", {
      feedId: input.feedId,
      url: mbasicUrl,
      hint: "Set FACEBOOK_SESSION_COOKIE in wrangler.jsonc secrets to enable Facebook scraping"
    });
    return { status: 403, items: [] };
  }

  // Derive page display name from og:title, <title>, or feed name
  const pageName =
    input.feedName ||
    extractFirst(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i) ||
    extractFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i) ||
    pageSlug;

  const maxItems = Number.isFinite(input.maxItems) ? Math.max(1, Math.min(input.maxItems, 60)) : 20;
  const items: ParsedFeedItem[] = [];

  // ── Strategy 1: <article> elements (mbasic wraps each story in <article>) ──
  const articleMatches = [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)];
  for (const match of articleMatches) {
    if (items.length >= maxItems) break;
    const articleHtml = match[1] || "";

    // Skip comment/reaction blocks
    if (/data-sigil="comment"/.test(articleHtml) || /data-ft="{[^}]*\"type\":\s*27/.test(articleHtml)) continue;

    // Extract post permalink
    const postLinkMatch =
      articleHtml.match(/href="(\/[^"]+\/posts\/[^"?#]+[^"]*?)"/) ||
      articleHtml.match(/href="(\/story\.php\?[^"]+)"/) ||
      articleHtml.match(/href="(\/permalink\/\d+\/?)"/);
    const rawPostLink = postLinkMatch
      ? postLinkMatch[1].replace(/&amp;/g, "&")
      : null;
    const postLink = rawPostLink
      ? `https://www.facebook.com${rawPostLink}`
      : input.url.replace(/\/$/, "");

    // Strip HTML and decode entities to get readable text
    const text = cleanText(articleHtml);
    if (!text || text.length < 15) continue;

    // Remove Facebook engagement noise (Like · Comment · Share etc.)
    const cleaned = text
      .replace(/\s*\b(Like|Comment|Share|Reply|See more|See less|Translated|Turn off translations?)\b\s*/gi, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (!cleaned || cleaned.length < 10) continue;

    // First image from the article block
    const imgMatch = articleHtml.match(/<img\b[^>]+src="([^"]+)"/i);
    const imageUrl = imgMatch ? toHttpsUrl(imgMatch[1]) : null;

    // Timestamp from <abbr title="...">
    const abbrMatch = articleHtml.match(/<abbr[^>]+title="([^"]+)"/i);
    const isoDate = abbrMatch ? toIsoOrNull(abbrMatch[1]) : null;

    items.push({
      title: pageName,
      link: postLink,
      guid: postLink !== input.url.replace(/\/$/, "") ? postLink : `${input.url}#fb-post-${items.length}`,
      isoDate,
      pubDate: isoDate,
      contentSnippet: cleaned.slice(0, 500),
      content: cleaned,
      author: pageName,
      imageUrl,
    });
  }

  // ── Strategy 2: story-permalink divs (older mbasic layout) ──
  if (items.length === 0) {
    const storyDivMatches = [
      ...html.matchAll(/<div[^>]+id="m_story_permalink_view[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi)
    ];
    for (const match of storyDivMatches) {
      if (items.length >= maxItems) break;
      const divHtml = match[1] || "";
      const text = cleanText(divHtml).trim();
      if (!text || text.length < 15) continue;
      const cleaned = text
        .replace(/\s*\b(Like|Comment|Share|Reply|See more|See less)\b\s*/gi, " ")
        .replace(/\s{2,}/g, " ")
        .trim();
      if (!cleaned || cleaned.length < 10) continue;
      // Build a stable content-based suffix so each post gets a unique URL
      const contentKey = cleaned.slice(0, 48).replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-+|-+$/g, "");
      const postLink = `${input.url.replace(/\/?$/, "")}?p=${encodeURIComponent(contentKey)}_${items.length}`;
      const imgMatch = divHtml.match(/<img\b[^>]+src="([^"]+)"/i);
      items.push({
        title: pageName,
        link: postLink,
        guid: postLink,
        isoDate: null,
        pubDate: null,
        contentSnippet: cleaned.slice(0, 500),
        content: cleaned,
        author: pageName,
        imageUrl: imgMatch ? toHttpsUrl(imgMatch[1]) : null,
      });
    }
  }

  if (items.length === 0) {
    logWarn("ingest.facebook.no_posts", {
      feedId: input.feedId,
      url: mbasicUrl,
      htmlLength: html.length,
    });
  }

  return { status, items };
}

export async function scrapeFeedItems(input: ScrapeFeedInput): Promise<ScrapeFeedResult> {
  const kind = resolveScraperKind(input.url, input.scraperId);
  const maxItems = Number.isFinite(input.maxItems) ? Math.max(1, Math.min(input.maxItems, 120)) : 60;
  const listingUrls = buildListingUrls(input.url, kind);

  let bestStatus = 200;
  const discovered: Candidate[] = [];

  for (const listUrl of listingUrls) {
    try {
      const fetched = await fetchHtml(listUrl, input.userAgent, LIST_TIMEOUT_MS, LIST_MAX_CHARS);
      bestStatus = fetched.status;
      const sourceHost = new URL(fetched.finalUrl).hostname;

      const fromJsonLd = extractJsonLdCandidates(fetched.html, fetched.finalUrl, kind, sourceHost);
      const fromAnchors = extractAnchorCandidates(fetched.html, fetched.finalUrl, kind, sourceHost);
      const fromLoose = extractLooseUrlCandidates(fetched.html, fetched.finalUrl, kind, sourceHost);
      discovered.push(...fromJsonLd, ...fromAnchors, ...fromLoose);

      if (discovered.length >= maxItems * 3) break;
    } catch (err) {
      logWarn("ingest.scrape.list.fetch_failed", {
        feedId: input.feedId,
        scraper: kind,
        listUrl,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const merged = mergeCandidates(discovered).slice(0, Math.max(maxItems * 3, 48));
  if (!merged.length) {
    throw new Error(`Scraper ${kind} found no candidates for ${input.url}`);
  }

  const metaTargets = merged.slice(0, Math.min(MAX_META_FETCHES, Math.max(maxItems, 8)));
  const metaResults = await mapWithConcurrency(metaTargets, META_CONCURRENCY, async (candidate) => {
    const meta = await fetchArticleMeta(candidate.link, input.userAgent);
    return { candidate, meta };
  });

  const metaByLink = new Map<string, ArticleMeta>();
  for (const entry of metaResults) {
    if (entry.meta) metaByLink.set(entry.candidate.link, entry.meta);
  }

  const normalized = merged.map((candidate) => {
    const meta = metaByLink.get(candidate.link);
    const canonical = meta?.canonicalUrl ? canonicalizeUrl(meta.canonicalUrl, candidate.link) : null;
    const link = canonical || candidate.link;
    return {
      link,
      title: cleanTitle(candidate.title || meta?.title || "(untitled)"),
      isoDate: candidate.isoDate || meta?.isoDate || null,
      snippet: candidate.snippet || meta?.snippet || null,
      imageUrl: candidate.imageUrl || meta?.imageUrl || null,
      author: candidate.author || meta?.author || null,
      score: candidate.score
    } satisfies Candidate;
  });

  const finalCandidates = mergeCandidates(normalized).slice(0, maxItems);
  const items = finalCandidates.map(toParsedFeedItem);
  return { status: bestStatus, items };
}
