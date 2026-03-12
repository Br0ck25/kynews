import type { ExtractedArticle, IngestResult, IngestSource, NewArticle } from '../types';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { summarizeArticle } from './ai';
import { classifyArticleWithAi, isShortContentAllowed, BETTING_CONTENT_RE, isStatewideKyPoliticalStory } from './classify';
import { findArticleByHash, insertArticle, isUrlHashBlocked, listRecentArticleTitles } from './db';
import { browserFetch, cachedTextFetch, normalizeCanonicalUrl, sha256Hex, toIsoDateOrNull, wordCount } from './http';
import { decodeHtmlEntities, scrapeArticleHtml } from './scrape';

const TITLE_SIMILARITY_REJECT_THRESHOLD = 0.85; // lowered from 0.9 to catch more cross-outlet duplicates
const RECENT_TITLE_SCAN_LIMIT = 300; // reduced scan limit for performance (formerly 700)

// stop words to ignore when selecting the first meaningful word of a title
const STOP_WORDS = new Set([
  'the','and','for','are','but','not','you','all','can','her',
  'was','one','our','out','day','get','has','him','his','how',
  'its','may','new','now','old','see','two','who','did','let',
  'put','say','she','too','use','a','an','in','of','on','to','is',
]);

function firstMeaningfulWord(title: string): string {
  const words = title.toLowerCase().split(/\s+/);
  for (const w of words) {
    const clean = w.replace(/[^a-z]/g, '');
    if (clean.length >= 4 && !STOP_WORDS.has(clean)) return clean;
  }
  return words[0] ?? '';
}

export async function ingestSingleUrl(env: Env, source: IngestSource): Promise<IngestResult> {
  // Pre-flight duplicate check using the normalized source URL.  This allows
  // queue-sourced messages to short-circuit before performing any network
  // fetch, readability work, or expensive AI classification.  It also helps
  // avoid CPU‑limit loops caused by retrying messages that refer to an
  // article already inserted under the same canonical form.
  const sourceUrlHash = await sha256Hex(normalizeCanonicalUrl(source.url));
  const preflightDuplicate = await findArticleByHash(env, sourceUrlHash);
  if (preflightDuplicate) {
    return {
      status: 'duplicate',
      id: preflightDuplicate.id,
      urlHash: sourceUrlHash,
      category: preflightDuplicate.category,
    };
  }

  const extracted = await fetchAndExtractArticle(env, source);
  const rssTitle = source.providedTitle?.trim() ?? '';
  const rssDescription = source.providedDescription?.trim() ?? '';
  // RSS-only primary relevance check payload.
  const textToCheck = [rssTitle, rssDescription].filter(Boolean).join(' ');

  const canonicalHash = await sha256Hex(extracted.canonicalUrl);
  const blocked = await isUrlHashBlocked(env, canonicalHash);
  if (blocked) {
    return {
      status: 'rejected',
      reason: 'blocked by admin',
      urlHash: canonicalHash,
    };
  }

  const duplicate = await findArticleByHash(env, canonicalHash);
  if (duplicate) {
    return {
      status: 'duplicate',
      id: duplicate.id,
      urlHash: canonicalHash,
      category: duplicate.category,
    };
  }

  const similarTitle = await findHighlySimilarTitle(env, extracted.title);
  if (similarTitle) {
    return {
      status: 'rejected',
      reason: `title similarity ${(similarTitle.similarity * 100).toFixed(1)}% with existing article #${similarTitle.id}`,
      urlHash: canonicalHash,
    };
  }

  // content fingerprint dedupe: small hash of first 150 words of text
  let contentFingerprintKey: string | null = null;
  if (!similarTitle) {
    const contentFingerprint = await sha256Hex(
      extracted.contentText.split(/\s+/).slice(0, 150).join(' ').toLowerCase(),
    );
    contentFingerprintKey = `cfp:${contentFingerprint}`;
    if (env.CACHE) {
      const existing = await env.CACHE.get(contentFingerprintKey);
      if (existing) {
        return {
          status: 'duplicate',
          reason: 'content fingerprint match',
          urlHash: canonicalHash,
        };
      }
    }
  }

  const words = wordCount(extracted.contentText);

  // compute hash of first 3000 words for change detection baseline
  const contentSample = extracted.contentText.split(/\s+/).slice(0, 3000).join(' ');
  const contentHash = await sha256Hex(contentSample);
  if (!source.allowShortContent && !isShortContentAllowed(extracted.canonicalUrl, words)) {
    return {
      status: 'rejected',
      reason: `content too short (${words} words)`,
      urlHash: canonicalHash,
    };
  }

  // Use AI (GLM-4.7-Flash) to classify the article; falls back to keywords if AI fails
  const classification = await classifyArticleWithAi(env, {
    url: extracted.canonicalUrl,
    title: rssTitle || extracted.title,
    content: extracted.classificationText || textToCheck,
    rssTitle,
    rssDescription,
  });

  // For statewide Kentucky political roundups we intentionally clear any
  // primary county even if our classifier returned one.  The `counties`
  // array may still contain secondary tags for filtering purposes.
  const statewideFlag = isStatewideKyPoliticalStory(
    extracted.classificationText || extracted.contentText || ''
  );
  if (statewideFlag && classification.counties && classification.counties.length > 0) {
    classification.county = null;
  }

  const tierSuffix = classification.isKentucky
    ? classification.counties && classification.counties.length
      ? ` (counties: ${classification.counties.join(', ')})`
      : ''
    : '';
  console.log(`[CLASSIFIED] ${classification.isKentucky ? 'kentucky' : 'national'} - ${extracted.title}${tierSuffix}`);

  // Reject pure betting/odds/gambling articles before summarization.
  // These are CBS Sports / SportsLine model-pick articles with no
  // local news value — they should not be stored in the DB.
  if (BETTING_CONTENT_RE.test(extracted.contentText.slice(0, 2000))) {
    console.log(`[REJECTED] betting/odds content: ${extracted.title}`);
    return {
      status: 'rejected',
      reason: 'betting/odds content — not local news',
      urlHash: canonicalHash,
    };
  }

  const ai = await summarizeArticle(env, canonicalHash, extracted.title, extracted.contentText, extracted.publishedAt);

  // if this is just a preview request we stop after summarization/classification
  // and return the article fields without actually writing anything to the
  // database or R2.  The returned object uses the same `status: 'inserted'`
  // value that a real insertion would, so the frontend can treat the payload
  // uniformly.  Extra fields (title/summary/etc) are added via the expanded
  // IngestResult type.
  if (source.preview) {
    return {
      status: 'inserted',
      urlHash: canonicalHash,
      category: classification.category,
      slug: generateArticleSlug(extracted.title, canonicalHash),
      title: extracted.title,
      summary: ai.summary,
      seoDescription: ai.seoDescription,
      imageUrl: extracted.imageUrl,
      publishedAt: extracted.publishedAt,
      isKentucky: classification.isKentucky,
      isNational: classification.isNational,
      county: classification.county,
      counties: classification.counties,
      city: classification.city,
      contentText: extracted.contentText,
      canonicalUrl: extracted.canonicalUrl,
      sourceUrl: extracted.sourceUrl,
    };
  }

  const rawR2Key = await storeRawPayloadBestEffort(env, canonicalHash, {
    source,
    extracted,
    classification,
    wordCount: words,
  });

  const newArticle: NewArticle = {
    canonicalUrl: extracted.canonicalUrl,
    sourceUrl: extracted.sourceUrl,
    urlHash: canonicalHash,
    title: extracted.title,
    author: extracted.author,
    publishedAt: extracted.publishedAt,
    category: classification.category,
    isKentucky: classification.isKentucky,
    isNational: classification.isNational,
    county: classification.county,
    counties: classification.counties,
    city: classification.city,
    summary: ai.summary,
    seoDescription: ai.seoDescription,
    rawWordCount: words,
    summaryWordCount: ai.summaryWordCount,
    contentText: extracted.contentText,
    contentHtml: extracted.contentHtml,
    imageUrl: extracted.imageUrl,
    rawR2Key,
    contentHash,
    // SEO-friendly slug: title-slug + first 8 chars of urlHash for uniqueness (Section 4)
    slug: generateArticleSlug(extracted.title, canonicalHash),
  };

  // NOTE: Existing rows inserted before this classifier update may have stale
  // Kentucky/county/or national tags. The `is_national` flag is stored separately
  // so older articles will default to `0` until we run a reclassification pass.
  //
  // Backfill instructions: the admin API already exposes a `/api/admin/reclassify`
  // endpoint which pages through articles and applies the current classification
  // logic (category, is_kentucky, is_national, county, etc). Running that endpoint
  // repeatedly until it returns `No more articles to reclassify` will refresh all
  // historical rows. Execute this once before deploying the updated worker so the
  // new feeds (weather, national) behave correctly.
  //
  // Previous TODO: "Run backfillReclassify() against all rows where created_at <
  // [DEPLOYMENT_DATE]" has been satisfied by the reclassify endpoint above.
  let articleId: number;
  try {
    articleId = await insertArticle(env, newArticle);
  } catch (error) {
    // convert error to safe string for logs and response
    const msg = error instanceof Error ? error.message : String(error);
    // UNIQUE constraint means we've already inserted the article under some
    // form of the URL; treat it as a duplicate rather than a fatal rejection.
    if (msg.includes('UNIQUE constraint') || msg.includes('SQLITE_CONSTRAINT')) {
      console.warn('[DUPLICATE ON INSERT]', extracted.title, msg);
      return {
        status: 'duplicate',
        reason: 'url_hash already exists (late duplicate detection)',
        urlHash: canonicalHash,
      };
    }
    console.error('[INSERT FAILED]', extracted.title, msg);
    return {
      status: 'rejected',
      reason: `insert failed: ${msg}`,
      urlHash: canonicalHash,
    };
  }

  // after successful insert, record fingerprint for a few days if we computed one
  if (contentFingerprintKey && env.CACHE) {
    await env.CACHE.put(contentFingerprintKey, String(articleId), {
      expirationTtl: 60 * 60 * 72,
    }).catch(() => {});
  }

  return {
    status: 'inserted',
    id: articleId,
    urlHash: canonicalHash,
    category: classification.category,
    slug: newArticle.slug,
  };
}

export async function fetchAndExtractArticle(env: Env, source: IngestSource): Promise<ExtractedArticle> {
  // If the caller supplied a manual description text (e.g. user pasted
  // article text into the admin form) we should skip all network fetch and
  // HTML-scraping logic and just return the provided string as-is.  This
  // preserves any double-newline paragraph breaks rather than letting the
  // breadcrumb/nav stripping regexes collapse them.
  if (source.allowShortContent === true && source.providedDescription) {
    const description = source.providedDescription.trim();
    const title = source.providedTitle?.trim() || source.url;
    const resolvedPublishedAt = toIsoDateOrNull(source.feedPublishedAt) ?? new Date().toISOString();
    const normalizedCanonical = normalizeCanonicalUrl(source.url);
    const normalizedSource = normalizeCanonicalUrl(source.sourceUrl ?? source.url);
    return {
      canonicalUrl: normalizedCanonical,
      sourceUrl: normalizedSource,
      title,
      author: null,
      publishedAt: resolvedPublishedAt,
      contentHtml: description,
      contentText: description,
      classificationText: [source.providedTitle, source.providedDescription].filter(Boolean).join(' ').slice(0, 4000),
      imageUrl: null,
    };
  }

  // Manual admin ingests (preview: undefined with a direct URL call) use a
  // browser-like UA to bypass basic bot detection on sites like kentucky.com.
  // Scheduled RSS ingests continue to use the cached bot UA path.
  const isManualIngest = source.allowShortContent === true || !source.feedPublishedAt;

  let fetchedBody: string;
  let fetchedStatus: number;
  let fetchedContentType: string | null;

  if (isManualIngest) {
    const result = await browserFetch(source.url);
    if (result.blockedByBot) {
      throw new Error(
        `Bot protection detected on ${new URL(source.url).hostname} — the site is blocking automated access. ` +
        `Try copying the article text manually and using the manual text ingest option, ` +
        `or access the article through a source that syndicates it.`
      );
    }
    if (result.status >= 400) {
      throw new Error(`Failed to fetch URL (${result.status}): ${source.url}`);
    }
    fetchedBody = result.body;
    fetchedStatus = result.status;
    fetchedContentType = result.contentType;
  } else {
    const fetched = await cachedTextFetch(env, source.url, 1200);
    if (fetched.status >= 400) {
      throw new Error(`Failed to fetch URL (${fetched.status}): ${source.url}`);
    }
    fetchedBody = fetched.body;
    fetchedStatus = fetched.status;
    fetchedContentType = fetched.contentType;
  }

  const isHtml = (fetchedContentType ?? '').includes('html') || fetchedBody.includes('<html');

  if (!isHtml) {
    const description = source.providedDescription?.trim() ?? '';
    const title = source.providedTitle?.trim() || source.url;
    const resolvedPublishedAt = toIsoDateOrNull(source.feedPublishedAt) ?? new Date().toISOString();
    const normalizedCanonical = normalizeCanonicalUrl(source.url);
    const normalizedSource = normalizeCanonicalUrl(source.sourceUrl ?? source.url);
    return {
      canonicalUrl: normalizedCanonical,
      sourceUrl: normalizedSource,
      title,
      author: null,
      publishedAt: resolvedPublishedAt,
      contentHtml: description,
      contentText: description,
      classificationText: [source.providedTitle, source.providedDescription].filter(Boolean).join(' ').slice(0, 4000),
      imageUrl: null,
    };
  }

  const scraped = scrapeArticleHtml(source.url, fetchedBody);
  const readability = extractReadableArticle(fetchedBody);
  // Do NOT prepend the title here — it causes AI to echo the title in summaries.
  // Keep readableText for classification only; use htmlToStructuredText for summarization.
  const readableText = (readability?.textContent ?? '').trim();
  const readableHtml = readability?.content?.trim() ?? '';
  // Paragraph-structured plain text derived from the Readability HTML for better AI input
  const structuredText = readableHtml ? htmlToStructuredText(readableHtml) : readableText;

  // Never classify from raw HTML. If Readability fails, fallback to RSS title/description only.
  const rssText = [source.providedTitle, source.providedDescription].filter(Boolean).join(' ').trim();

  const synthesizedText =
    structuredText ||
    readableText ||
    scraped.contentText ||
    source.providedDescription ||
    source.providedTitle ||
    '';
  const classificationLead = (structuredText || readableText || rssText || '').slice(0, 4000);

  const resolvedPublishedAt =
    scraped.publishedAt ??
    toIsoDateOrNull(source.feedPublishedAt) ??
    new Date().toISOString();
  const normalizedCanonical = normalizeCanonicalUrl(scraped.canonicalUrl);
  const normalizedSource = normalizeCanonicalUrl(source.sourceUrl ?? source.url);

  // For government/agency sites where the page <title> is the site name
  // rather than the article title, prefer the RSS-provided title.
  const resolvedTitle = (() => {
    const readabilityTitle = readability?.title?.trim() || '';
    const scrapedTitle = scraped.title?.trim() || '';
    const rssTitle = source.providedTitle?.trim() || '';

    // If the readability/scraped title looks like a generic site name
    // (short, no punctuation, matches the domain brand) prefer the RSS title.
    const isSiteName = (t: string) =>
      rssTitle &&
      t !== rssTitle &&
      (
        /^kentucky\s+state\s+police$/i.test(t) ||
        /^(?:home|news|press releases?|latest news)$/i.test(t) ||
        // TV/radio station name pattern: "WLEX News - City, KY (CALL)" or "LEX 18 News - Lexington, KY (WLEX)"
        // Distinguishing feature: ends with call letters in parens, or is "STATION - City, ST" format
        /\b[A-Z]{2,5}\s*\d*\s*(?:News|TV|Radio)?\s*[-–]\s*[A-Za-z\s]+,\s*[A-Z]{2}\s*(?:\([A-Z]{3,5}\))?\s*$/.test(t) ||
        // Station name without a city: "WLEX-TV", "WKYT News", "LEX 18 News"
        /^(?:[A-Z]{1,2}\s*)?[A-Z]{2,4}\s*\d*\s*(?:News|TV|Radio|Mountain\s+News)?\s*$/.test(t) ||
        // Generic: title is 1-4 words and RSS title is clearly longer/more specific
        (t.length < 60 && !/[,.:!?\'"()\d]/.test(t) && t.split(/\s+/).length <= 4 && rssTitle.split(/\s+/).length > 4)
      );

    if (isSiteName(readabilityTitle) || isSiteName(scrapedTitle)) {
      return rssTitle || readabilityTitle || scrapedTitle || source.url;
    }
    return readabilityTitle || scrapedTitle || rssTitle || source.url;
  })();

  // NWS/weather.gov RSS titles enumerate every affected county in a long
  // comma-separated list that often gets truncated mid-word at ~200 chars.
  // Clean these up: strip the trailing cut-off fragment and condense the
  // county list to the first few counties with "and N more" suffix.
  const cleanedTitle = cleanNwsTitle(resolvedTitle);

  // NWS/NOAA pages have no og:image meta tag.  Derive the product image
  // directly from the URL where possible (SPC discussions, watches, etc.),
  // then fall back to the NWS logo so cards never render as a gray box.
  const resolvedImageUrl = scraped.imageUrl || derivedNwsImageUrl(normalizedCanonical);

  return {
    canonicalUrl: normalizedCanonical,
    sourceUrl: normalizedSource,
    title: cleanedTitle,
    author: scraped.author,
    publishedAt: resolvedPublishedAt,
    contentHtml: readableHtml || scraped.contentHtml,
    contentText: synthesizedText,
    classificationText: classificationLead,
    imageUrl: resolvedImageUrl,
  };
}

/**
 * NWS RSS titles list every affected county inline, e.g.:
 *   "Wind Advisory Issued for Wayne and Fayette and ... and Mas"
 *
 * This helper:
 *  1. Strips any mid-word trailing fragment caused by RSS character limits.
 *  2. If the title is still very long, condenses the county list to the first
 *     3 counties with "and N more counties" appended.
 */
function cleanNwsTitle(title: string): string {
  if (!title) return title;

  // Pattern: "<Alert Type> Issued for <county list>" or "<Alert Type> in effect for <county list>"
  const alertMatch = /^(.*?(?:Issued|In Effect|Warning|Watch|Advisory|Statement)\s+(?:for|until|through|in effect)?)\s+(.*)/i.exec(title);
  if (!alertMatch) return title;

  const prefix = alertMatch[1].trim();
  let countyPart = alertMatch[2].trim();

  // Remove trailing incomplete word: if the last word doesn't end with a letter
  // that could close a proper county name, strip back to the last "and" or comma.
  // County names always end with a full word.
  if (/\s+\S{1,3}$/.test(countyPart)) {
    // Last token is suspiciously short — likely a truncation artifact.
    countyPart = countyPart.replace(/\s+\S{1,3}$/, '').replace(/\s+and\s*$/, '').trim();
  }

  // Split on " and " to get individual county names
  const counties = countyPart.split(/\s+and\s+/i).map((c) => c.trim()).filter(Boolean);

  const MAX_COUNTIES = 3;
  if (counties.length <= MAX_COUNTIES) {
    return `${prefix} ${counties.join(' and ')}`;
  }

  const shown = counties.slice(0, MAX_COUNTIES).join(', ');
  const remaining = counties.length - MAX_COUNTIES;
  return `${prefix} ${shown} and ${remaining} more ${remaining === 1 ? 'county' : 'counties'}`;
}

/**
 * For NWS/NOAA product pages that have no og:image, derive the product
 * image URL directly from the page URL where the pattern is known.
 *
 * Supported patterns:
 *  SPC Mesoscale Discussions
 *    https://www.spc.noaa.gov/products/md/md0212.html  → .../mcd0212.png
 *  SPC Tornado/Severe Thunderstorm Watches
 *    https://www.spc.noaa.gov/products/watch/ww0041.html → .../ww0041.png
 *  SPC Convective Outlooks
 *    https://www.spc.noaa.gov/products/outlook/day1otlk.html → .../day1otlk.gif
 *  NWS local area forecast discussions / text products
 *    (no reliable image — fall back to NWS logo)
 *
 * Returns null for non-NWS/NOAA URLs so the caller can skip the fallback.
 */
function derivedNwsImageUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();

  // ── SPC (Storm Prediction Center) ──────────────────────────────────────
  if (host === 'www.spc.noaa.gov' || host === 'spc.noaa.gov') {
    // Mesoscale Discussions: /products/md/md####.html → /products/md/mcd####.png
    const mdMatch = /\/products\/md\/md(\d+)\.html?$/i.exec(parsed.pathname);
    if (mdMatch) {
      return `https://www.spc.noaa.gov/products/md/mcd${mdMatch[1]}.png`;
    }

    // Watches: /products/watch/ww####.html → /products/watch/ww####.png
    const watchMatch = /\/products\/watch\/(ww\d+)\.html?$/i.exec(parsed.pathname);
    if (watchMatch) {
      return `https://www.spc.noaa.gov/products/watch/${watchMatch[1]}.png`;
    }

    // Convective Outlooks: /products/outlook/day[N]otlk*.html → .gif
    const outlookMatch = /\/products\/outlook\/(day\d+otlk[^/]*)\.html?$/i.exec(parsed.pathname);
    if (outlookMatch) {
      return `https://www.spc.noaa.gov/products/outlook/${outlookMatch[1]}.gif`;
    }

    // Generic SPC fallback — use the SPC logo
    return 'https://www.spc.noaa.gov/images/spclogosmall.gif';
  }

  // ── NWS weather.gov ────────────────────────────────────────────────────
  if (host.endsWith('.weather.gov') || host === 'weather.gov') {
    return 'https://www.weather.gov/images/nws/nws_logo.png';
  }

  // ── Other NOAA domains ─────────────────────────────────────────────────
  if (host.endsWith('.noaa.gov') || host === 'noaa.gov') {
    return 'https://www.weather.gov/images/nws/nws_logo.png';
  }

  return null;
}

function extractReadableArticle(rawHtml: string): { title?: string; textContent?: string; content?: string } | null {
  try {
    const { document } = parseHTML(rawHtml);
    const reader = new Readability(document);
    const parsed = reader.parse();
    if (!parsed) return null;

    return {
      title: parsed.title ?? undefined,
      textContent: parsed.textContent ?? undefined,
      content: parsed.content ?? undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Convert Readability HTML to paragraph-structured plain text.
 * Preserves paragraph breaks so the AI can produce proper multi-paragraph summaries.
 */
function htmlToStructuredText(html: string): string {
  // Replace block-level closing tags with double newlines
  let text = html
    .replace(/<\/(?:p|div|blockquote|li|h[1-6]|section|article|figure|figcaption)\s*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ''); // strip remaining tags

  text = decodeHtmlEntities(text);

  // Collapse runs of spaces/tabs (but not newlines)
  text = text.replace(/\u00a0/g, ' ').replace(/[^\S\n]+/g, ' ');
  // Collapse 3+ newlines to 2
  text = text.replace(/\n{3,}/g, '\n\n');
  // Trim each line
  text = text.split('\n').map((l) => l.trim()).join('\n');

  return text.trim();
}

async function storeRawPayloadBestEffort(
  env: Env,
  hash: string,
  payload: unknown,
): Promise<string | null> {
  try {
    const now = new Date();
    const key = `raw/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${String(now.getUTCDate()).padStart(2, '0')}/${hash}.json`;
    await env.ky_news_media.put(key, JSON.stringify(payload));
    return key;
  } catch {
    return null;
  }
}

/**
 * Generate an SEO-friendly URL slug from an article title + hash suffix for uniqueness.
 * e.g. "School Board Meeting Feb 2026" + "ab12cd34..." → "school-board-meeting-feb-2026-ab12cd34"
 */
export function generateArticleSlug(title: string, urlHash: string): string {
  const titleSlug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60)
    .replace(/^-|-$/g, '');
  const hashSuffix = urlHash.slice(0, 8);
  return titleSlug ? `${titleSlug}-${hashSuffix}` : hashSuffix;
}

export async function findHighlySimilarTitle(
  env: Env,
  title: string,
): Promise<{ id: number; title: string; similarity: number } | null> {
  const normalizedTarget = normalizeTitleForSimilarity(title);
  if (!normalizedTarget || normalizedTarget.length < 12) return null;

  const targetFirstWord = firstMeaningfulWord(normalizedTarget);

  const recentTitles = await listRecentArticleTitles(env, RECENT_TITLE_SCAN_LIMIT);
  let best: { id: number; title: string; similarity: number } | null = null;

  for (const candidate of recentTitles) {
    if (!candidate?.title) continue;

    const normalizedCandidate = normalizeTitleForSimilarity(candidate.title);
    if (!normalizedCandidate) continue;

    // skip quickly if first meaningful words differ
    if (firstMeaningfulWord(normalizedCandidate) !== targetFirstWord) continue;

    const maxLen = Math.max(normalizedTarget.length, normalizedCandidate.length);
    const minLen = Math.min(normalizedTarget.length, normalizedCandidate.length);
    if (maxLen === 0) continue;

    // Fast skip: Levenshtein similarity cannot exceed the shorter/longer ratio.
    if ((minLen / maxLen) < TITLE_SIMILARITY_REJECT_THRESHOLD) continue;

    const similarity = titleSimilarity(normalizedTarget, normalizedCandidate);
    if (similarity < TITLE_SIMILARITY_REJECT_THRESHOLD) continue;

    if (!best || similarity > best.similarity) {
      best = { id: candidate.id, title: candidate.title, similarity };
    }
    // early exit when very close match found
    if (best && best.similarity >= 0.98) break;
  }

  return best;
}

function normalizeTitleForSimilarity(input: string): string {
  return decodeHtmlEntities(input || '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;

  const distance = levenshteinDistance(a, b);
  return 1 - (distance / maxLen);
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);

  for (let j = 0; j <= b.length; j += 1) previous[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost,
      );
    }
    [previous, current] = [current, previous];
  }

  return previous[b.length] ?? Math.max(a.length, b.length);
}
