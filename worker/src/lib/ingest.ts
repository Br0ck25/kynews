import type { ExtractedArticle, IngestResult, IngestSource, NewArticle } from '../types';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { summarizeArticle } from './ai';
import { classifyArticleWithAi, isShortContentAllowed } from './classify';
import { findArticleByHash, insertArticle, isUrlHashBlocked, listRecentArticleTitles } from './db';
import { cachedTextFetch, normalizeCanonicalUrl, sha256Hex, toIsoDateOrNull, wordCount } from './http';
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

  const tierSuffix = classification.isKentucky
    ? classification.counties && classification.counties.length
      ? ` (counties: ${classification.counties.join(', ')})`
      : ''
    : '';
  console.log(`[CLASSIFIED] ${classification.isKentucky ? 'kentucky' : 'national'} - ${extracted.title}${tierSuffix}`);

  const ai = await summarizeArticle(env, canonicalHash, extracted.title, extracted.contentText, extracted.publishedAt);

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
  };
}

export async function fetchAndExtractArticle(env: Env, source: IngestSource): Promise<ExtractedArticle> {
  const fetched = await cachedTextFetch(env, source.url, 1200);
  if (fetched.status >= 400) {
    throw new Error(`Failed to fetch URL (${fetched.status}): ${source.url}`);
  }

  const isHtml = (fetched.contentType ?? '').includes('html') || fetched.body.includes('<html');

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

  const scraped = scrapeArticleHtml(source.url, fetched.body);
  const readability = extractReadableArticle(fetched.body);
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

  return {
    canonicalUrl: normalizedCanonical,
    sourceUrl: normalizedSource,
    title: readability?.title || scraped.title || source.providedTitle || source.url,
    author: scraped.author,
    publishedAt: resolvedPublishedAt,
    contentHtml: readableHtml || scraped.contentHtml,
    contentText: synthesizedText,
    classificationText: classificationLead,
    imageUrl: scraped.imageUrl,
  };
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
