import type { ExtractedArticle, IngestResult, IngestSource, NewArticle } from '../types';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { summarizeArticle } from './ai';
import { classifyArticleWithAi, isShortContentAllowed } from './classify';
import { findArticleByHash, insertArticle } from './db';
import { cachedTextFetch, sha256Hex, toIsoDate, wordCount } from './http';
import { scrapeArticleHtml } from './scrape';

export async function ingestSingleUrl(env: Env, source: IngestSource): Promise<IngestResult> {
  const extracted = await fetchAndExtractArticle(env, source);
  const rssTitle = source.providedTitle?.trim() ?? '';
  const rssDescription = source.providedDescription?.trim() ?? '';
  // RSS-only primary relevance check payload.
  const textToCheck = [rssTitle, rssDescription].filter(Boolean).join(' ');

  const canonicalHash = await sha256Hex(extracted.canonicalUrl);
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
  if (!isShortContentAllowed(extracted.canonicalUrl, words)) {
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

  // AI summary is disabled – we display full text on the front end.
  const ai = { summary: '', seoDescription: '', summaryWordCount: 0 };

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
    return {
      canonicalUrl: source.url,
      sourceUrl: source.sourceUrl ?? source.url,
      title,
      author: null,
      publishedAt: toIsoDate(source.feedPublishedAt),
      contentHtml: description,
      contentText: description,
      classificationText: [source.providedTitle, source.providedDescription].filter(Boolean).join(' '),
      imageUrl: null,
    };
  }

  const scraped = scrapeArticleHtml(source.url, fetched.body);
  const readability = extractReadableArticle(fetched.body);
  const readableText = [readability?.title, readability?.textContent].filter(Boolean).join(' ').trim();
  const readableHtml = readability?.content?.trim() ?? '';

  // Never classify from raw HTML. If Readability fails, fallback to RSS title/description only.
  const rssText = [source.providedTitle, source.providedDescription].filter(Boolean).join(' ').trim();

  const synthesizedText =
    readableText ||
    scraped.contentText ||
    source.providedDescription ||
    source.providedTitle ||
    '';

  return {
    canonicalUrl: scraped.canonicalUrl,
    sourceUrl: source.sourceUrl ?? source.url,
    title: readability?.title || scraped.title || source.providedTitle || source.url,
    author: scraped.author,
    publishedAt: scraped.publishedAt || toIsoDate(source.feedPublishedAt),
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
    return reader.parse();
  } catch {
    return null;
  }
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
