export interface ArticleFetchResult {
  status: string;
  text: string;
  ogImage: string | null;
}

const ARTICLE_TIMEOUT_MS = 12_000;
const ARTICLE_MAX_CHARS = 2_000_000;
const EXCERPT_MAX_CHARS = 10_000;

function stripTags(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
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
  if (fromOg && /^https?:\/\//i.test(fromOg)) return fromOg;

  const fromOgName = firstMatch(html, /<meta[^>]+name=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  if (fromOgName && /^https?:\/\//i.test(fromOgName)) return fromOgName;

  const fromTw = firstMatch(html, /<meta[^>]+property=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  if (fromTw && /^https?:\/\//i.test(fromTw)) return fromTw;

  const fromTwName = firstMatch(html, /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  if (fromTwName && /^https?:\/\//i.test(fromTwName)) return fromTwName;

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
      if (/^https?:\/\//i.test(abs)) return abs;
    } catch {
      // continue
    }
  }

  return null;
}

function extractReadableText(html: string): string {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const source = bodyMatch?.[1] || html;
  const text = stripTags(source);
  return text.length > EXCERPT_MAX_CHARS ? text.slice(0, EXCERPT_MAX_CHARS) : text;
}

export async function fetchArticle(url: string): Promise<ArticleFetchResult> {
  if (!url || !/^https?:\/\//i.test(url)) {
    return { status: "skip", text: "", ogImage: null };
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
      return { status: `http_${res.status}`, text: "", ogImage: null };
    }

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return { status: "non_html", text: "", ogImage: null };
    }

    let html = await res.text();
    if (html.length > ARTICLE_MAX_CHARS) html = html.slice(0, ARTICLE_MAX_CHARS);

    const ogImage = pickOgImage(html) || pickInlineImage(html, url);
    const text = extractReadableText(html);
    return { status: "ok", text, ogImage };
  } catch {
    return { status: "error", text: "", ogImage: null };
  } finally {
    clearTimeout(timeout);
  }
}
