import { decodeHtmlEntities, normalizeWhitespace, toHttpsUrl } from "../lib/text";

export interface ArticleFetchResult {
  status: string;
  text: string;
  ogImage: string | null;
  publishedAt: string | null;
}

const ARTICLE_TIMEOUT_MS = 12_000;
const ARTICLE_MAX_CHARS = 2_000_000;
const EXCERPT_MAX_CHARS = 10_000;
const NAV_CLUSTER_RE =
  /\b(?:home|news|sports|opinion|obituaries|features|classifieds|public notices|contests|calendar|services|about us|policies|news tip|submit photo|engagement announcement|wedding announcement|anniversary announcement|letter to editor|submit an obituary|pay subscription|e-edition)(?:\s+\b(?:home|news|sports|opinion|obituaries|features|classifieds|public notices|contests|calendar|services|about us|policies|news tip|submit photo|engagement announcement|wedding announcement|anniversary announcement|letter to editor|submit an obituary|pay subscription|e-edition)\b){4,}/gi;

function stripTags(input: string): string {
  return decodeHtmlEntities(input)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstMatch(html: string, re: RegExp): string | null {
  const match = html.match(re);
  const value = match?.[1]?.trim();
  return value || null;
}

function pickOgImage(html: string): string | null {
  const fromOg = firstMatch(html, /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  const ogUrl = toHttpsUrl(fromOg);
  if (ogUrl) return ogUrl;

  const fromOgName = firstMatch(html, /<meta[^>]+name=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  const ogNameUrl = toHttpsUrl(fromOgName);
  if (ogNameUrl) return ogNameUrl;

  const fromTw = firstMatch(html, /<meta[^>]+property=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  const twUrl = toHttpsUrl(fromTw);
  if (twUrl) return twUrl;

  const fromTwName = firstMatch(html, /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  const twNameUrl = toHttpsUrl(fromTwName);
  if (twNameUrl) return twNameUrl;

  return null;
}

function pickInlineImage(html: string, pageUrl: string): string | null {
  const imgRegex = /<img[^>]+(?:src|data-src|data-lazy-src|data-original)=["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null = null;

  while ((match = imgRegex.exec(html))) {
    const src = String(match[1] || "").trim();
    if (!src || src.startsWith("data:")) continue;
    if (/\b(sprite|logo|icon|avatar)\b/i.test(src)) continue;

    try {
      const abs = new URL(src, pageUrl).toString();
      const https = toHttpsUrl(abs);
      if (https) return https;
    } catch {
      // continue
    }
  }

  return null;
}

function toIsoOrNull(input: string | null | undefined): string | null {
  if (!input) return null;
  const dt = new Date(input);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

function pickPublishedAt(html: string): string | null {
  const fields = [
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+name=["']article:published_time["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+property=["']og:article:published_time["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+name=["']parsely-pub-date["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+itemprop=["']datePublished["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<time[^>]+datetime=["']([^"']+)["'][^>]*>/i
  ];
  for (const pattern of fields) {
    const value = firstMatch(html, pattern);
    const iso = toIsoOrNull(value);
    if (iso) return iso;
  }
  return null;
}

function cleanExtractedText(input: string): string {
  return normalizeWhitespace(
    decodeHtmlEntities(input)
      .replace(/\bYou are using an outdated browser[\s\S]{0,260}?experience\.\s*/gi, " ")
      .replace(/\bSubscribe\b[\s\S]{0,500}?\bE-Edition\b/gi, " ")
      .replace(NAV_CLUSTER_RE, " ")
      .replace(/\s+/g, " ")
  );
}

function extractReadableText(html: string): string {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ");

  const candidates: RegExp[] = [
    /<article[^>]*>([\s\S]*?)<\/article>/gi,
    /<main[^>]*>([\s\S]*?)<\/main>/gi,
    /<section[^>]+(?:id|class)=["'][^"']*(?:article|story|post|entry|content-body|article-body|story-body|entry-content)[^"']*["'][^>]*>([\s\S]*?)<\/section>/gi,
    /<div[^>]+(?:id|class)=["'][^"']*(?:article|story|post|entry|content-body|article-body|story-body|entry-content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi
  ];

  let bestText = "";
  let bestScore = -1;
  for (const re of candidates) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null = null;
    while ((match = re.exec(cleaned))) {
      const block = match[1] || "";
      if (!block) continue;
      const paragraphCount = (block.match(/<p\b/gi) || []).length;
      const text = cleanExtractedText(stripTags(block));
      if (!text) continue;
      const navHits = (text.match(/\b(home|subscribe|classifieds|public notices|calendar|services)\b/gi) || []).length;
      const score = text.length + paragraphCount * 120 - navHits * 45;
      if (score > bestScore) {
        bestScore = score;
        bestText = text;
      }
    }
  }

  if (!bestText || bestText.length < 220) {
    const bodyMatch = cleaned.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    bestText = cleanExtractedText(stripTags(bodyMatch?.[1] || cleaned));
  }

  const text = cleanExtractedText(bestText);
  return text.length > EXCERPT_MAX_CHARS ? text.slice(0, EXCERPT_MAX_CHARS) : text;
}

export async function fetchArticle(url: string): Promise<ArticleFetchResult> {
  if (!url || !/^https?:\/\//i.test(url)) {
    return { status: "skip", text: "", ogImage: null, publishedAt: null };
  }

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), ARTICLE_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; EKY-News-Worker/1.0)",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });

    if (res.status < 200 || res.status >= 300) {
      return { status: `http_${res.status}`, text: "", ogImage: null, publishedAt: null };
    }

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return { status: "non_html", text: "", ogImage: null, publishedAt: null };
    }

    let html = await res.text();
    if (html.length > ARTICLE_MAX_CHARS) html = html.slice(0, ARTICLE_MAX_CHARS);

    const ogImage = pickOgImage(html) || pickInlineImage(html, url);
    const publishedAt = pickPublishedAt(html);
    const text = extractReadableText(html);
    return { status: "ok", text, ogImage, publishedAt };
  } catch {
    return { status: "error", text: "", ogImage: null, publishedAt: null };
  } finally {
    clearTimeout(timeout);
  }
}
