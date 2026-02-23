import type { ArticleListResponse, ArticleRecord, Category, NewArticle } from '../types';
import { normalizeCountyList } from './geo';

interface ArticleRow {
  id: number;
  canonical_url: string;
  source_url: string;
  url_hash: string;
  title: string;
  author: string | null;
  published_at: string;
  category: Category;
  is_kentucky: number;
  county: string | null;
  city: string | null;
  summary: string;
  seo_description: string;
  raw_word_count: number;
  summary_word_count: number;
  content_text: string;
  content_html: string;
  image_url: string | null;
  raw_r2_key: string | null;
  created_at: string;
  updated_at: string;
}

export async function findArticleByHash(env: Env, urlHash: string): Promise<ArticleRecord | null> {
  const result = await env.ky_news_db
    .prepare(`SELECT * FROM articles WHERE url_hash = ? LIMIT 1`)
    .bind(urlHash)
    .first<ArticleRow>();

  return result ? mapArticleRow(result) : null;
}

export async function insertArticle(env: Env, article: NewArticle): Promise<number> {
  const normalizedCounty = normalizeCountyName(article.county);

  const result = await env.ky_news_db
    .prepare(
      `INSERT INTO articles (
        canonical_url,
        source_url,
        url_hash,
        title,
        author,
        published_at,
        category,
        is_kentucky,
        county,
        city,
        summary,
        seo_description,
        raw_word_count,
        summary_word_count,
        content_text,
        content_html,
        image_url,
        raw_r2_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      article.canonicalUrl,
      article.sourceUrl,
      article.urlHash,
      article.title,
      article.author,
      article.publishedAt,
      article.category,
      article.isKentucky ? 1 : 0,
      normalizedCounty,
      article.city,
      article.summary,
      article.seoDescription,
      article.rawWordCount,
      article.summaryWordCount,
      article.contentText,
      article.contentHtml,
      article.imageUrl,
      article.rawR2Key,
    )
    .run();

  return Number(result.meta.last_row_id ?? 0);
}

export async function queryArticles(env: Env, options: {
  category: Category;
  counties: string[];
  search: string | null;
  limit: number;
  cursor: string | null;
}): Promise<ArticleListResponse> {
  const where: string[] = [];
  const binds: unknown[] = [];

  if (options.category === 'today') {
    where.push('is_kentucky = 1');
  } else if (options.category === 'sports') {
    where.push('category = ?');
    binds.push('sports');
    where.push('is_kentucky = 1');
  } else {
    // national, weather, schools, obituaries – filter by stored category value
    where.push('category = ?');
    binds.push(options.category);
  }

  // National should always show all national stories regardless of county filters.
  if (options.category !== 'national' && options.counties.length > 0) {
    where.push(`county IN (${options.counties.map(() => '?').join(',')})`);
    binds.push(...options.counties);
  }

  if (options.search) {
    where.push('(title LIKE ? OR content_text LIKE ?)');
    const token = `%${escapeLike(options.search)}%`;
    binds.push(token, token);
  }

  if (options.cursor) {
    where.push('id < ?');
    binds.push(Number.parseInt(options.cursor, 10) || Number.MAX_SAFE_INTEGER);
  }

  binds.push(options.limit + 1);

  // Guard: always ensure a WHERE clause exists (empty-where would be invalid SQL)
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : 'WHERE 1=1';
  const query = `SELECT * FROM articles ${whereClause} ORDER BY published_at DESC, id DESC LIMIT ?`;

  const rows = await env.ky_news_db.prepare(query).bind(...binds).all<ArticleRow>();
  const mapped = (rows.results ?? []).map(mapArticleRow);

  const hasMore = mapped.length > options.limit;
  const items = hasMore ? mapped.slice(0, options.limit) : mapped;

  return {
    items,
    nextCursor: hasMore ? String(items[items.length - 1]?.id ?? '') : null,
  };
}

function mapArticleRow(row: ArticleRow): ArticleRecord {
  return {
    id: row.id,
    canonicalUrl: row.canonical_url,
    sourceUrl: row.source_url,
    urlHash: row.url_hash,
    title: row.title,
    author: row.author,
    publishedAt: row.published_at,
    category: row.category,
    isKentucky: row.is_kentucky === 1,
    county: row.county,
    city: row.city,
    summary: row.summary,
    seoDescription: row.seo_description,
    rawWordCount: row.raw_word_count,
    summaryWordCount: row.summary_word_count,
    contentText: row.content_text,
    contentHtml: row.content_html,
    imageUrl: row.image_url,
    rawR2Key: row.raw_r2_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** Fetch a batch of articles (by descending id) starting below a given id threshold.
 *  Used by the admin re-classify endpoint to process existing articles page-by-page. */
export async function listArticlesForReclassify(
  env: Env,
  { limit, beforeId }: { limit: number; beforeId: number | null },
): Promise<ArticleRecord[]> {
  const where = beforeId != null ? 'WHERE id < ?' : '';
  const binds = beforeId != null ? [beforeId, limit] : [limit];
  const query = `SELECT * FROM articles ${where} ORDER BY published_at DESC, id DESC LIMIT ?`;
  const rows = await env.ky_news_db.prepare(query).bind(...binds).all<ArticleRow>();
  return (rows.results ?? []).map(mapArticleRow);
}

/** Update the category, is_kentucky, and county for an existing article row. */
export async function updateArticleClassification(
  env: Env,
  id: number,
  patch: { category: Category; isKentucky: boolean; county: string | null },
): Promise<void> {
  const normalizedCounty = normalizeCountyName(patch.county);

  await env.ky_news_db
    .prepare('UPDATE articles SET category = ?, is_kentucky = ?, county = ? WHERE id = ?')
    .bind(patch.category, patch.isKentucky ? 1 : 0, normalizedCounty, id)
    .run();
}

function normalizeCountyName(value: string | null): string | null {
  if (!value) return null;
  const normalized = normalizeCountyList([value]);
  return normalized[0] ?? null;
}
