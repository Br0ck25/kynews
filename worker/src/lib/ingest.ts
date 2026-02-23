import type { ExtractedArticle, IngestResult, IngestSource, NewArticle } from '../types';
import { summarizeArticle } from './ai';
import { classifyArticle, isShortContentAllowed } from './classify';
import { findArticleByHash, insertArticle } from './db';
import { cachedTextFetch, sha256Hex, toIsoDate, wordCount } from './http';
import { scrapeArticleHtml } from './scrape';

export async function ingestSingleUrl(env: Env, source: IngestSource): Promise<IngestResult> {
  const extracted = await fetchAndExtractArticle(env, source);

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

  const classification = classifyArticle({
    url: extracted.canonicalUrl,
    title: extracted.title,
    content: extracted.contentText,
  });

  const ai = await summarizeArticle(
    env,
    canonicalHash,
    extracted.title,
    extracted.contentText,
  );

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
      imageUrl: null,
    };
  }

  const scraped = scrapeArticleHtml(source.url, fetched.body);

  const synthesizedText =
    scraped.contentText ||
    source.providedDescription ||
    source.providedTitle ||
    '';

  return {
    canonicalUrl: scraped.canonicalUrl,
    sourceUrl: source.sourceUrl ?? source.url,
    title: scraped.title || source.providedTitle || source.url,
    author: scraped.author,
    publishedAt: scraped.publishedAt || toIsoDate(source.feedPublishedAt),
    contentHtml: scraped.contentHtml,
    contentText: synthesizedText,
    imageUrl: scraped.imageUrl,
  };
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
