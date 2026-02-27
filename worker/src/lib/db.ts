import type { ArticleListResponse, ArticleRecord, Category, NewArticle } from '../types';
import { normalizeCountyList } from './geo';
import { normalizeCanonicalUrl } from './http';

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
  is_national: number;
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
  slug: string | null;
  created_at: string;
  updated_at: string;
}

interface SourceStatsRow {
  source_url: string;
  article_count: number;
  latest_published_at: string;
}

interface BlockedArticleRow {
  id: number;
  canonical_url: string;
  source_url: string | null;
  url_hash: string;
  reason: string | null;
  created_at: string;
}

interface RecentTitleRow {
  id: number;
  title: string;
}

export async function findArticleByHash(env: Env, urlHash: string): Promise<ArticleRecord | null> {
  const result = await env.ky_news_db
    .prepare(`SELECT * FROM articles WHERE url_hash = ? LIMIT 1`)
    .bind(urlHash)
    .first<ArticleRow>();

  return result ? mapArticleRow(result) : null;
}

export async function listRecentArticleTitles(env: Env, limit = 600): Promise<Array<{ id: number; title: string }>> {
  const safeLimit = Math.min(Math.max(Math.floor(limit || 0), 1), 2000);
  const rows = await env.ky_news_db
    .prepare(`SELECT id, title FROM articles ORDER BY id DESC LIMIT ?`)
    .bind(safeLimit)
    .all<RecentTitleRow>();

  return (rows.results ?? []).map((row) => ({
    id: row.id,
    title: row.title,
  }));
}

export async function getArticleById(env: Env, id: number): Promise<ArticleRecord | null> {
  const result = await env.ky_news_db
    .prepare(`SELECT * FROM articles WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<ArticleRow>();

  return result ? mapArticleRow(result) : null;
}

export async function getArticleBySlug(env: Env, slug: string): Promise<ArticleRecord | null> {
  const result = await env.ky_news_db
    .prepare(`SELECT * FROM articles WHERE slug = ? LIMIT 1`)
    .bind(slug)
    .first<ArticleRow>();

  return result ? mapArticleRow(result) : null;
}

export async function insertArticle(env: Env, article: NewArticle): Promise<number> {
  const normalizedCounty = normalizeCountyName(article.county);

  try {
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
          is_national,
          county,
          city,
          summary,
          seo_description,
          raw_word_count,
          summary_word_count,
          content_text,
          content_html,
          image_url,
          raw_r2_key,
          slug
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        article.isNational ? 1 : 0,
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
        article.slug ?? null,
      )
      .run();

    return Number(result.meta.last_row_id ?? 0);
  } catch (error) {
    // log full error along with article metadata so issues are visible in worker logs
    console.error('[DB INSERT ERROR]', error, {
      url: article.canonicalUrl,
      title: article.title,
      hash: article.urlHash,
    });
    throw error;
  }
}

export async function updateArticlePublishedAt(env: Env, id: number, publishedAt: string): Promise<void> {
  await env.ky_news_db
    .prepare('UPDATE articles SET published_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(publishedAt, id)
    .run();
}

export async function updateArticleContent(
  env: Env,
  id: number,
  patch: { title?: string; summary?: string },
): Promise<void> {
  const sets: string[] = ['updated_at = CURRENT_TIMESTAMP'];
  const binds: unknown[] = [];

  if (patch.title !== undefined) {
    sets.push('title = ?');
    binds.push(patch.title.trim().slice(0, 500));
  }

  if (patch.summary !== undefined) {
    sets.push('summary = ?');
    binds.push(patch.summary.trim().slice(0, 8000));
  }

  if (sets.length === 1) return; // nothing to update besides updated_at
  binds.push(id);

  await env.ky_news_db
    .prepare(`UPDATE articles SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();
}

export async function updateArticleLinks(
  env: Env,
  id: number,
  patch: { canonicalUrl: string; sourceUrl: string; urlHash: string },
): Promise<void> {
  await env.ky_news_db
    .prepare(
      'UPDATE articles SET canonical_url = ?, source_url = ?, url_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    )
    .bind(patch.canonicalUrl, patch.sourceUrl, patch.urlHash, id)
    .run();
}

export async function deleteArticleById(env: Env, id: number): Promise<void> {
  await env.ky_news_db
    .prepare('DELETE FROM articles WHERE id = ?')
    .bind(id)
    .run();
}

export async function blockArticleByIdAndDelete(
  env: Env,
  id: number,
  reason: string | null,
): Promise<{ blocked: boolean; deleted: boolean }> {
  const article = await env.ky_news_db
    .prepare('SELECT canonical_url, source_url, url_hash FROM articles WHERE id = ? LIMIT 1')
    .bind(id)
    .first<{ canonical_url: string; source_url: string; url_hash: string }>();

  if (!article) {
    return { blocked: false, deleted: false };
  }

  await ensureBlockedArticlesTable(env);
  await env.ky_news_db
    .prepare(
      `INSERT OR REPLACE INTO blocked_articles (canonical_url, source_url, url_hash, reason, created_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    )
    .bind(article.canonical_url, article.source_url, article.url_hash, reason)
    .run();

  await deleteArticleById(env, id);
  return { blocked: true, deleted: true };
}

export async function isUrlHashBlocked(env: Env, urlHash: string): Promise<boolean> {
  await ensureBlockedArticlesTable(env);
  const result = await env.ky_news_db
    .prepare('SELECT id FROM blocked_articles WHERE url_hash = ? LIMIT 1')
    .bind(urlHash)
    .first<{ id: number }>();

  return Boolean(result?.id);
}

export async function listBlockedArticles(env: Env): Promise<Array<{
  id: number;
  canonicalUrl: string;
  sourceUrl: string | null;
  urlHash: string;
  reason: string | null;
  createdAt: string;
}>> {
  await ensureBlockedArticlesTable(env);
  const rows = await env.ky_news_db
    .prepare('SELECT * FROM blocked_articles ORDER BY id DESC LIMIT 500')
    .all<BlockedArticleRow>();

  return (rows.results ?? []).map((row) => ({
    id: row.id,
    canonicalUrl: row.canonical_url,
    sourceUrl: row.source_url,
    urlHash: row.url_hash,
    reason: row.reason,
    createdAt: row.created_at,
  }));
}

export async function unblockArticleByBlockedId(env: Env, id: number): Promise<boolean> {
  await ensureBlockedArticlesTable(env);
  const result = await env.ky_news_db
    .prepare('DELETE FROM blocked_articles WHERE id = ?')
    .bind(id)
    .run();

  return Number(result.meta.changes ?? 0) > 0;
}

export async function getCountyCounts(env: Env): Promise<Map<string, number>> {
  const rows = await env.ky_news_db
    .prepare(
      `SELECT county, COUNT(*) as cnt FROM articles WHERE county IS NOT NULL GROUP BY county`
    )
    .all<{ county: string; cnt: number }>();

  const map = new Map<string, number>();
  for (const row of rows.results ?? []) {
    if (row.county) {
      map.set(row.county, Number(row.cnt ?? 0));
    }
  }

  return map;
}

// Query the database schema to determine whether a given column
// exists.  We intentionally avoid long‑lived caching because migrations may
// run in the same worker runtime and alter the table structure (tests drop
// and recreate the table), and caching would otherwise cause stale results.
async function columnExists(env: Env, table: string, column: string): Promise<boolean> {
  const rows = await env.ky_news_db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  for (const row of rows.results ?? []) {
    if (row.name === column) return true;
  }
  return false;
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
  } else if (options.category === 'schools') {
    where.push('category = ?');
    binds.push('schools');
    where.push('is_kentucky = 1');
  } else if (options.category === 'obituaries') {
    // obituaries feed: Kentucky obits only (per spec)
    where.push('category = ?');
    binds.push('obituaries');
    where.push('is_kentucky = 1');
  } else if (options.category === 'weather') {
    // weather feed: include Kentucky weather OR articles explicitly tagged
    // national + weather.  The `is_national` column was added later, so older
    // databases may not have it; fall back gracefully to a simpler query in
    // that case rather than throwing a SQL error (which resulted in 500s).
    const supportsIsNational = await columnExists(env, 'articles', 'is_national');
    if (supportsIsNational) {
      where.push('((is_kentucky = 1 AND category = ?) OR (is_national = 1 AND category = ?))');
      binds.push('weather', 'weather');
    } else {
      where.push('category = ?');
      binds.push('weather');
    }
  } else {
    // national – filter by stored category value
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

  const sqlLimit = Math.min((options.limit * 3) + 5, 300);
  binds.push(sqlLimit);

  // Guard: always ensure a WHERE clause exists (empty-where would be invalid SQL)
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : 'WHERE 1=1';
  const query = `SELECT * FROM articles ${whereClause} ORDER BY published_at DESC, id DESC LIMIT ?`;

  const rows = await env.ky_news_db.prepare(query).bind(...binds).all<ArticleRow>();
  const mapped = (rows.results ?? []).map(mapArticleRow);
  const uniqueItems: ArticleRecord[] = [];
  const seenCanonical = new Set<string>();

  for (const article of mapped) {
    const dedupeKey = normalizeCanonicalUrl(article.canonicalUrl || article.sourceUrl || '');
    if (dedupeKey && seenCanonical.has(dedupeKey)) continue;
    if (dedupeKey) seenCanonical.add(dedupeKey);
    uniqueItems.push(article);
    if (uniqueItems.length > options.limit) break;
  }

  const hasMore = uniqueItems.length > options.limit;
  const items = hasMore ? uniqueItems.slice(0, options.limit) : uniqueItems;

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
    isNational: row.is_national === 1,
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
    slug: row.slug ?? null,
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
  patch: { category: Category; isKentucky: boolean; isNational?: boolean; county: string | null },
): Promise<void> {
  const normalizedCounty = normalizeCountyName(patch.county);

  await env.ky_news_db
    .prepare('UPDATE articles SET category = ?, is_kentucky = ?, is_national = ?, county = ? WHERE id = ?')
    .bind(
      patch.category,
      patch.isKentucky ? 1 : 0,
      patch.isNational ? 1 : 0,
      normalizedCounty,
      id,
    )
    .run();
}

function normalizeCountyName(value: string | null): string | null {
  if (!value) return null;
  const normalized = normalizeCountyList([value]);
  return normalized[0] ?? null;
}

export async function listAdminArticles(env: Env, options: {
  limit: number;
  cursor: string | null;
  search: string | null;
  category: Category | 'all';
}): Promise<ArticleListResponse> {
  const where: string[] = [];
  const binds: unknown[] = [];

  if (options.category !== 'all') {
    where.push('category = ?');
    binds.push(options.category);
  }

  if (options.search) {
    where.push('(title LIKE ? OR source_url LIKE ? OR county LIKE ?)');
    const token = `%${escapeLike(options.search)}%`;
    binds.push(token, token, token);
  }

  if (options.cursor) {
    where.push('id < ?');
    binds.push(Number.parseInt(options.cursor, 10) || Number.MAX_SAFE_INTEGER);
  }

  binds.push(options.limit + 1);
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
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

export async function getSourceStats(env: Env): Promise<Array<{
  sourceUrl: string;
  articleCount: number;
  latestPublishedAt: string;
  status: 'active' | 'idle';
}>> {
  const rows = await env.ky_news_db
    .prepare(
      `SELECT source_url, COUNT(*) as article_count, MAX(published_at) as latest_published_at
       FROM articles
       GROUP BY source_url
       ORDER BY article_count DESC, latest_published_at DESC`,
    )
    .all<SourceStatsRow>();

  const now = Date.now();
  const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;

  return (rows.results ?? []).map((row) => {
    const latestTs = Date.parse(row.latest_published_at || '');
    const isActive = Number.isFinite(latestTs) && now - latestTs <= fourteenDaysMs;
    return {
      sourceUrl: row.source_url,
      articleCount: Number(row.article_count ?? 0),
      latestPublishedAt: row.latest_published_at,
      status: isActive ? 'active' : 'idle',
    };
  });
}

async function ensureBlockedArticlesTable(env: Env): Promise<void> {
  await env.ky_news_db
    .prepare(
      `CREATE TABLE IF NOT EXISTS blocked_articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        canonical_url TEXT NOT NULL,
        source_url TEXT,
        url_hash TEXT NOT NULL UNIQUE,
        reason TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    )
    .run();

  await env.ky_news_db
    .prepare('CREATE INDEX IF NOT EXISTS idx_blocked_articles_hash ON blocked_articles(url_hash)')
    .run();
}
