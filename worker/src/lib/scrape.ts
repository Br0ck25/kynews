import { normalizeCanonicalUrl, toIsoDateOrNull } from './http';

const META_REGEXPS: Record<string, RegExp[]> = {
  title: [
    /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["'][^>]*>/i,
    /<meta[^>]+name=["']twitter:title["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']twitter:title["'][^>]*>/i,
  ],
  description: [
    /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:description["'][^>]*>/i,
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']description["'][^>]*>/i,
  ],
  image: [
    // og:image with optional suffix (e.g. og:image:secure_url)
    /<meta[^>]+property=["']og:image(?:[:][^"']*)?["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image(?:[:][^"']*)?["'][^>]*>/i,
    // twitter image meta
    /<meta[^>]+name=["']twitter:image["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']twitter:image["'][^>]*>/i,
    // general link rel image_src
    /<link[^>]+rel=["']image_src["'][^>]*href=["']([^"']+)["'][^>]*>/i,
  ],
  author: [
    /<meta[^>]+name=["']author["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']author["'][^>]*>/i,
    /<meta[^>]+property=["']article:author["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']article:author["'][^>]*>/i,
  ],
  publishedAt: [
    /<meta[^>]+property=["']article:published_time["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']article:published_time["'][^>]*>/i,
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
  let imageUrl = findMeta('image', html);

  const articleHtml =
    matchFirst(html, /<article[^>]*>([\s\S]*?)<\/article>/i) ??
    matchFirst(html, /<main[^>]*>([\s\S]*?)<\/main>/i) ??
    matchFirst(html, /<body[^>]*>([\s\S]*?)<\/body>/i) ??
    html;

  // If no image meta was found, look for a picture inside the article
  // fragment.  We prefer the first explicitly-loaded source, then fall back
  // to lazy-/data-src attributes or the first URL in a srcset.
  if (!imageUrl) {
    let imgMatch = articleHtml.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (!imgMatch) {
      imgMatch = articleHtml.match(/<img[^>]+data-src=["']([^"']+)["']/i);
    }
    if (!imgMatch) {
      const setMatch = articleHtml.match(/<img[^>]+srcset=["']([^"']+)["']/i);
      if (setMatch && setMatch[1]) {
        // take the first src from the set (comma separated list)
        const parts = setMatch[1].split(',').map((p) => p.trim());
        if (parts.length > 0) {
          // RegExpMatchArray element types must be string.  We only care about
          // the second element so insert an empty string and cast.
          imgMatch = ["" as any, parts[0].split(' ')[0]] as RegExpMatchArray;
        }
      }
    }
    if (imgMatch && imgMatch[1]) {
      imageUrl = imgMatch[1];
    }
  }

  const cleanedHtml = stripNoisyTags(articleHtml);
  const contentText = normalizeText(stripHtml(cleanedHtml));

  // Remove WordPress/CMS breadcrumb navigation that sometimes gets
  // included at the beginning of the scraped text.  These look like
  // "Home » Region/State »" and confuse the summarizer/AI.
  const contentTextClean = contentText
    .replace(/^(?:Home\s*[»›>|]\s*)+[^.!?\n]{0,120}(?:[»›>|][^.!?\n]{0,120})*\s*/i, '')
    .trim();

  // Strip WordPress/WP-based vertical nav menus that appear as a list of
  // category names on separate lines before the article body.
  // Pattern: 3+ short single-word/hyphenated lines (nav items) followed by article content.
  const contentTextClean2 = contentTextClean
    .replace(
      /^(?:(?:Business|Education|Government|Health|Living|News|NonProfit|Region\/State|Sports|Voices|About|Contact|Subscribe|Advertise|Events|Opinion|Community|Politics|Economy|Environment|Science|Technology|Culture|Arts|Entertainment|Local|National|World|Weather|Obituaries|Jobs|Classifieds)\s*\n){2,}/i,
      '',
    )
    .trim();

  return {
    canonicalUrl: normalizeCanonicalUrl(absolutizeMaybe(canonical, sourceUrl)),
    title: normalizeText(title),
    author: author ? normalizeText(author) : null,
    publishedAt,
    contentHtml: cleanedHtml,
    contentText: contentTextClean2,
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
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ')
    // Strip TV closed-caption transcript blocks — all-caps text
    // that dominates summaries when articles have thin prose.
    // The previous regex was too greedy and stopped at the first closing
    // </div> when nested divs were present.  Use a pattern that consumes any
    // nested closing tags in a run.
    .replace(/<div\b[^>]*\bclass=["'][^"']*\btranscript\b[^"']*["'][^>]*>[\s\S]*?<\/div>(\s*<\/div>)*/gi, ' ');
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

/**
 * Attempt to read the pixel dimensions of a remote image without downloading
 * the full file.  Performs a HEAD request first to confirm the content type,
 * then fetches only the first 24 bytes and parses:
 *   - PNG: IHDR chunk width/height at byte offsets 16–19 / 20–23
 *   - JPEG: scans for the SOF0 (FF C0) or SOF2 (FF C2) marker within the
 *     available bytes (succeeds for images whose SOF marker falls very early,
 *     otherwise returns null).
 *
 * Returns null on any network error, unsupported type, or parse failure.
 */
export async function getImageDimensions(url: string): Promise<{ width: number; height: number } | null> {
  try {
    // Step 1: HEAD to confirm content type within 3 s.
    const headController = new AbortController();
    const headTimeout = setTimeout(() => headController.abort(), 3000);
    let headResp: Response;
    try {
      headResp = await fetch(url, { method: 'HEAD', signal: headController.signal });
    } finally {
      clearTimeout(headTimeout);
    }

    const ct = (headResp.headers.get('content-type') ?? '').toLowerCase();
    const isPng = ct.includes('image/png');
    const isJpeg = ct.includes('image/jpeg');
    if (!isPng && !isJpeg) return null;

    // Step 2: Fetch only the first 24 bytes.
    const rangeController = new AbortController();
    const rangeTimeout = setTimeout(() => rangeController.abort(), 3000);
    let rangeResp: Response;
    try {
      rangeResp = await fetch(url, {
        headers: { Range: 'bytes=0-23' },
        signal: rangeController.signal,
      });
    } finally {
      clearTimeout(rangeTimeout);
    }

    const buf = await rangeResp.arrayBuffer();
    const bytes = new Uint8Array(buf);

    if (isPng && bytes.length >= 24) {
      // PNG layout: 8-byte signature, then IHDR chunk.
      // IHDR: 4-byte length, 4-byte type ("IHDR"), 4-byte width, 4-byte height.
      const view = new DataView(buf);
      const width = view.getUint32(16, false /* big-endian */);
      const height = view.getUint32(20, false);
      if (width > 0 && height > 0) return { width, height };
    }

    if (isJpeg && bytes.length >= 11) {
      // Scan the available bytes for an SOF0 (FF C0) or SOF2 (FF C2) marker.
      // In practice these markers are rarely within the first 24 bytes of a
      // JPEG file, so this will mostly return null — but it's correct per spec.
      const view = new DataView(buf);
      for (let i = 0; i < bytes.length - 8; i++) {
        if (bytes[i] === 0xff && (bytes[i + 1] === 0xc0 || bytes[i + 1] === 0xc2)) {
          // SOF segment layout: FF Cx [2-byte length] [1-byte precision] [2-byte height] [2-byte width]
          const height = view.getUint16(i + 5, false);
          const width = view.getUint16(i + 7, false);
          if (width > 0 && height > 0) return { width, height };
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}
