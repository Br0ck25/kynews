import { normalizeCanonicalUrl, toIsoDateOrNull } from './http';

const META_REGEXPS: Record<string, RegExp[]> = {
  title: [
    /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+name=["']twitter:title["'][^>]*content=["']([^"']+)["'][^>]*>/i,
  ],
  description: [
    /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i,
  ],
  image: [
    /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+name=["']twitter:image["'][^>]*content=["']([^"']+)["'][^>]*>/i,
  ],
  author: [
    /<meta[^>]+name=["']author["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+property=["']article:author["'][^>]*content=["']([^"']+)["'][^>]*>/i,
  ],
  publishedAt: [
    /<meta[^>]+property=["']article:published_time["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<time[^>]+datetime=["']([^"']+)["'][^>]*>/i,
  ],
  canonical: [
    /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i,
  ],
};

export interface ScrapedDocument {
  canonicalUrl: string;
  title: string;
  author: string | null;
  publishedAt: string | null;
  contentHtml: string;
  contentText: string;
  imageUrl: string | null;
}

export function scrapeArticleHtml(sourceUrl: string, html: string): ScrapedDocument {
  const title =
    findMeta('title', html) ??
    decodeHtmlEntities(matchFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i) ?? '') ??
    sourceUrl;

  const canonical = findMeta('canonical', html) ?? sourceUrl;
  const author = findMeta('author', html);
  const publishedAt = toIsoDateOrNull(findMeta('publishedAt', html));
  const imageUrl = findMeta('image', html);

  const articleHtml =
    matchFirst(html, /<article[^>]*>([\s\S]*?)<\/article>/i) ??
    matchFirst(html, /<main[^>]*>([\s\S]*?)<\/main>/i) ??
    matchFirst(html, /<body[^>]*>([\s\S]*?)<\/body>/i) ??
    html;

  const cleanedHtml = stripNoisyTags(articleHtml);
  const contentText = normalizeText(stripHtml(cleanedHtml));

  return {
    canonicalUrl: normalizeCanonicalUrl(absolutizeMaybe(canonical, sourceUrl)),
    title: normalizeText(title),
    author: author ? normalizeText(author) : null,
    publishedAt,
    contentHtml: cleanedHtml,
    contentText,
    imageUrl: imageUrl ? absolutizeMaybe(imageUrl, sourceUrl) : null,
  };
}

export function normalizeText(input: string): string {
  return decodeHtmlEntities(input)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripNoisyTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ');
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ');
}

function findMeta(kind: keyof typeof META_REGEXPS, html: string): string | null {
  const patterns = META_REGEXPS[kind];
  for (const pattern of patterns) {
    const matched = matchFirst(html, pattern);
    if (matched) return decodeHtmlEntities(matched);
  }
  return null;
}

function matchFirst(input: string, regex: RegExp): string | null {
  const matched = input.match(regex);
  if (!matched || !matched[1]) return null;
  return matched[1];
}

export function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;?/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);?/gi, (_match: string, value: string) =>
      decodeCodePoint(value, 16, _match),
    )
    .replace(/&#([0-9]+);?/g, (_match: string, value: string) =>
      decodeCodePoint(value, 10, _match),
    );
}

function decodeCodePoint(value: string, radix: 10 | 16, fallback: string): string {
  const num = Number.parseInt(value, radix);
  if (!Number.isFinite(num) || num <= 0 || num > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(num);
  } catch {
    return fallback;
  }
}

function absolutizeMaybe(candidate: string, base: string): string {
  try {
    return new URL(candidate, base).toString();
  } catch {
    return candidate;
  }
}
