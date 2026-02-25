import type { ExtractedArticle, IngestResult, IngestSource, NewArticle } from '../types';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { summarizeArticle } from './ai';
import { classifyArticleWithAi, isShortContentAllowed } from './classify';
import { findArticleByHash, insertArticle, isUrlHashBlocked } from './db';
import { cachedTextFetch, sha256Hex, toIsoDateOrNull, wordCount } from './http';
import { scrapeArticleHtml } from './scrape';

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
    ? classification.county
      ? ` (county: ${classification.county})`
      : ''
    : '';
  console.log(`[CLASSIFIED] ${classification.isKentucky ? 'kentucky' : 'national'} - ${extracted.title}${tierSuffix}`);

  const ai = await summarizeArticle(env, canonicalHash, extracted.title, extracted.contentText);

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
    county: classification.county,
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

  // NOTE: Existing rows inserted before this classifier update may have stale Kentucky/county tags.
  // Run a one-time backfill reclassification job against historical records after deployment.
  const articleId = await insertArticle(env, newArticle);

  return {
    status: 'inserted',
    id: articleId,
    urlHash: canonicalHash,
    category: classification.category,
  };
}

async function fetchAndExtractArticle(env: Env, source: IngestSource): Promise<ExtractedArticle> {
  const fetched = await cachedTextFetch(env, source.url, 1200);
  if (fetched.status >= 400) {
    throw new Error(`Failed to fetch URL (${fetched.status}): ${source.url}`);
  }

  const isHtml = (fetched.contentType ?? '').includes('html') || fetched.body.includes('<html');

  if (!isHtml) {
    const description = source.providedDescription?.trim() ?? '';
    const title = source.providedTitle?.trim() || source.url;
    const resolvedPublishedAt = toIsoDateOrNull(source.feedPublishedAt) ?? new Date().toISOString();
    return {
      canonicalUrl: source.url,
      sourceUrl: source.sourceUrl ?? source.url,
      title,
      author: null,
      publishedAt: resolvedPublishedAt,
      contentHtml: description,
      contentText: description,
      classificationText: [source.providedTitle, source.providedDescription].filter(Boolean).join(' '),
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
  const structuredText = readableHtml ? htmlToStructuredText(readableHtml) : readableText;;

  // Never classify from raw HTML. If Readability fails, fallback to RSS title/description only.
  const rssText = [source.providedTitle, source.providedDescription].filter(Boolean).join(' ').trim();

  const synthesizedText =
    structuredText ||
    readableText ||
    scraped.contentText ||
    source.providedDescription ||
    source.providedTitle ||
    '';

  const resolvedPublishedAt =
    scraped.publishedAt ??
    toIsoDateOrNull(source.feedPublishedAt) ??
    new Date().toISOString();

  return {
    canonicalUrl: scraped.canonicalUrl,
    sourceUrl: source.sourceUrl ?? source.url,
    title: readability?.title || scraped.title || source.providedTitle || source.url,
    author: scraped.author,
    publishedAt: resolvedPublishedAt,
    contentHtml: readableHtml || scraped.contentHtml,
    contentText: synthesizedText,
    classificationText: readableText || rssText,
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
    .replace(/<[^>]+>/g, '') // strip remaining tags
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'");

  // Collapse runs of spaces/tabs (but not newlines)
  text = text.replace(/[^\S\n]+/g, ' ');
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
function generateArticleSlug(title: string, urlHash: string): string {
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
