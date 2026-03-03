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
  content_hash: string | null;
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

// Utility for forcing D1 to recompile prepared statements by appending a
// unique comment. Using Math.random() ensures that even retries within the
// same millisecond produce a unique SQL string, bypassing the D1 cache bug
// that causes "no such table: articles_old" after migrations.
function prepare(env: Env, sql: string) {
  const uniqueSql = `${sql} /* cache_bust_${Math.random()} */`;
  return env.ky_news_db.prepare(uniqueSql);
}

export async function findArticleByHash(env: Env, urlHash: string): Promise<ArticleRecord | null> {
  // first try the main articles table
  const result = await prepare(env, `SELECT * FROM articles WHERE url_hash = ? LIMIT 1`)
    .bind(urlHash)
    .first<ArticleRow>();

  if (result) {
    return mapArticleRow(result);
  }
  // if not found there, check the supplemental url_hashes mapping table
  const link = await prepare(env, `SELECT article_id FROM url_hashes WHERE hash = ? LIMIT 1`)
    .bind(urlHash)
    .first<{ article_id: number }>();
  if (link && link.article_id) {
    return getArticleById(env, link.article_id);
  }
  return null;
}

// insert a hash mapping (used for URL path dedup and any future alternative keys)
export async function insertUrlHash(env: Env, hash: string, articleId: number): Promise<void> {
  // create table on-the-fly in case migrations haven't run in tests
  await env.ky_news_db.prepare(
    `CREATE TABLE IF NOT EXISTS url_hashes (
      hash TEXT PRIMARY KEY,
      article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE
    )`
  ).run();

  await env.ky_news_db
    .prepare(`INSERT OR IGNORE INTO url_hashes (hash, article_id) VALUES (?, ?)`)
    .bind(hash, articleId)
    .run();
}

export async function listRecentArticleTitles(env: Env, limit = 600): Promise<Array<{ id: number; title: string }>> {
  const safeLimit = Math.min(Math.max(Math.floor(limit || 0), 1), 2000);
  const rows = await prepare(env, `SELECT id, title FROM articles ORDER BY id DESC LIMIT ?`)
    .bind(safeLimit)
    .all<RecentTitleRow>();

  return (rows.results ?? []).map((row) => ({
    id: row.id,
    title: row.title,
  }));
}

export async function getArticleById(env: Env, id: number): Promise<ArticleRecord | null> {
  const result = await prepare(env, `SELECT * FROM articles WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<ArticleRow>();

  return result ? mapArticleRow(result) : null;
}

export async function getArticleBySlug(env: Env, slug: string): Promise<ArticleRecord | null> {
  const result = await prepare(env, `SELECT * FROM articles WHERE slug = ? LIMIT 1`)
    .bind(slug)
    .first<ArticleRow>();

  return result ? mapArticleRow(result) : null;
}

export async function insertArticle(env: Env, article: NewArticle): Promise<number> {
  const normalizedCounty = normalizeCountyName(article.county);

  try {
    const result = await prepare(env,
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
          slug,
          content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        article.contentHash ?? null,
      )
      .run();

    const articleId = Number(result.meta.last_row_id ?? 0);

    // insert county associations
    if (article.counties && article.counties.length > 0) {
      for (const county of article.counties) {
        await prepare(env,
            `INSERT OR IGNORE INTO article_counties (article_id, county, is_primary)
             VALUES (?, ?, ?)`
          )
          .bind(articleId, county, county === article.county ? 1 : 0)
          .run();
      }
    } else if (article.county) {
      await prepare(env,
          `INSERT OR IGNORE INTO article_counties (article_id, county, is_primary)
           VALUES (?, ?, 1)`
        )
        .bind(articleId, article.county)
        .run();
    }

    return articleId;
  } catch (error) {
    console.error('[DB INSERT ERROR]', error, {
      url: article.canonicalUrl,
      title: article.title,
      hash: article.urlHash,
    });
    throw error;
  }
}

export async function getArticlesForUpdateCheck(
  env: Env,
  maxAgeHours: number = 24,
): Promise<Array<{
  id: number;
  urlHash: string;
  canonicalUrl: string;
  title: string;
  summary: string;
  publishedAt: string;
  contentHash: string | null;
}>> {
  const cutoff = new Date(
    Date.now() - maxAgeHours * 60 * 60 * 1000
  ).toISOString();

  const rows = await prepare(env,
      `SELECT id, url_hash, canonical_url, title, summary,
              published_at, content_hash
       FROM articles
       WHERE published_at >= ?
         AND is_kentucky = 1
       ORDER BY published_at DESC
       LIMIT 100`
    )
    .bind(cutoff)
    .all();

  return (rows.results ?? []).map((r: any) => ({
    id: Number(r.id),
    urlHash: String(r.url_hash),
    canonicalUrl: String(r.canonical_url),
    title: String(r.title),
    summary: String(r.summary ?? ''),
    publishedAt: String(r.published_at),
    contentHash: r.content_hash ? String(r.content_hash) : null,
  }));
}

export async function prependUpdateToSummary(
  env: Env,
  id: number,
  updateParagraph: string,
  newContentHash: string,
): Promise<void> {
  const row = await prepare(env, 'SELECT summary FROM articles WHERE id = ?')
    .bind(id)
    .first<{ summary: string }>();

  if (!row) return;

  const timeLabel = new Date().toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/New_York',
  });

  const updatedSummary =
    `Update (${timeLabel}): ${updateParagraph}\n\n${row.summary}`.trim();

  await prepare(env,
      `UPDATE articles
       SET summary = ?,
           content_hash = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(
      updatedSummary.slice(0, 8000),
      newContentHash,
      id,
    )
    .run();
}

export async function updateArticlePublishedAt(env: Env, id: number, publishedAt: string): Promise<void> {
  await prepare(env, 'UPDATE articles SET published_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
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

  if (sets.length === 1) return;
  binds.push(id);

  await prepare(env, `UPDATE articles SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();
}

export async function updateArticleLinks(
  env: Env,
  id: number,
  patch: { canonicalUrl: string; sourceUrl: string; urlHash: string },
): Promise<void> {
  await prepare(env,
      'UPDATE articles SET canonical_url = ?, source_url = ?, url_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    )
    .bind(patch.canonicalUrl, patch.sourceUrl, patch.urlHash, id)
    .run();
}

export async function deleteArticleById(env: Env, id: number): Promise<void> {
  await prepare(env, 'DELETE FROM articles WHERE id = ?')
    .bind(id)
    .run();
}

export async function blockArticleByIdAndDelete(
  env: Env,
  id: number,
  reason: string | null,
): Promise<{ blocked: boolean; deleted: boolean }> {
  const article = await prepare(env, 'SELECT canonical_url, source_url, url_hash FROM articles WHERE id = ? LIMIT 1')
    .bind(id)
    .first<{ canonical_url: string; source_url: string; url_hash: string }>();

  if (!article) {
    return { blocked: false, deleted: false };
  }

  await ensureBlockedArticlesTable(env);
  await prepare(env,
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
  const result = await prepare(env, 'SELECT id FROM blocked_articles WHERE url_hash = ? LIMIT 1')
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
  const rows = await prepare(env, 'SELECT * FROM blocked_articles ORDER BY id DESC LIMIT 500')
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
  const result = await prepare(env, 'DELETE FROM blocked_articles WHERE id = ?')
    .bind(id)
    .run();

  return Number(result.meta.changes ?? 0) > 0;
}

export async function getCountyCounts(env: Env): Promise<Map<string, number>> {
  const rows = await prepare(env, `
      SELECT county, COUNT(*) as cnt FROM (
        SELECT county FROM article_counties
        UNION ALL
        SELECT county FROM articles a
          WHERE county IS NOT NULL
            AND county != ''
            AND NOT EXISTS (
              SELECT 1 FROM article_counties ac WHERE ac.article_id = a.id
            )
      )
      GROUP BY county
    `)
    .all<{ county: string; cnt: number }>();

  const map = new Map<string, number>();
  for (const row of rows.results ?? []) {
    if (row.county) {
      map.set(row.county, Number(row.cnt ?? 0));
    }
  }

  return map;
}

export async function getArticleCounties(env: Env, articleId: number): Promise<string[]> {
  const rows = await prepare(env, 'SELECT county FROM article_counties WHERE article_id = ? ORDER BY is_primary DESC, id ASC')
    .bind(articleId)
    .all<{ county: string }>();
  return (rows.results ?? []).map((r) => r.county);
}

async function columnExists(env: Env, table: string, column: string): Promise<boolean> {
  const rows = await prepare(env, `PRAGMA table_info(${table})`).all<{ name: string }>();
  for (const row of rows.results ?? []) {
    if (row.name === column) return true;
  }
  return false;
}

export async function queryArticles(env: Env, options: {
  category: Category | 'all';
  counties: string[];
  search: string | null;
  limit: number;
  cursor: string | null;
}): Promise<ArticleListResponse> {
  const where: string[] = [];
  const binds: unknown[] = [];

  // If caller requested `all` we deliberately *omit* any category-related
  // predicates so the query can return articles regardless of their
  // assigned category.  This is typically used in conjunction with a
  // non-empty `search` term, but we don't actually care; returning every
  // article when category=all is a valid behaviour.
  if (options.category === 'all') {
    // nothing to add
  } else if (options.category === 'today') {
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
    where.push('category = ?');
    binds.push('obituaries');
    where.push('is_kentucky = 1');
  } else if (options.category === 'weather') {
    const supportsIsNational = await columnExists(env, 'articles', 'is_national');
    if (supportsIsNational) {
      where.push('((is_kentucky = 1 AND category = ?) OR (is_national = 1 AND category = ?))');
      binds.push('weather', 'weather');
    } else {
      where.push('category = ?');
      binds.push('weather');
    }
  } else {
    where.push('category = ?');
    binds.push(options.category);
  }

  if (options.category !== 'national' && options.counties.length > 0) {
    const placeholders = options.counties.map(() => '?').join(',');
    where.push(`(
      id IN (SELECT article_id FROM article_counties WHERE county IN (${placeholders}))
      OR county IN (${placeholders})
    )`);
    binds.push(...options.counties, ...options.counties);
  }

  if (options.search) {
    where.push('(title LIKE ? OR summary LIKE ?)');
    const token = `%${escapeLike(options.search)}%`;
    binds.push(token, token);
  }

  if (options.cursor) {
    where.push('id < ?');
    binds.push(Number.parseInt(options.cursor, 10) || Number.MAX_SAFE_INTEGER);
  }

  const sqlLimit = Math.min((options.limit * 3) + 5, 300);
  binds.push(sqlLimit);

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : 'WHERE 1=1';
  const query = `SELECT * FROM articles ${whereClause} ORDER BY published_at DESC, id DESC LIMIT ?`;

  const rows = await prepare(env, query).bind(...binds).all<ArticleRow>();
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
    counties: [],
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

export async function listArticlesForReclassify(
  env: Env,
  { limit, beforeId }: { limit: number; beforeId: number | null },
): Promise<ArticleRecord[]> {
  const where = beforeId != null ? 'WHERE id < ?' : '';
  const binds = beforeId != null ? [beforeId, limit] : [limit];
  const query = `SELECT * FROM articles ${where} ORDER BY published_at DESC, id DESC LIMIT ?`;
  const rows = await prepare(env, query).bind(...binds).all<ArticleRow>();
  return (rows.results ?? []).map(mapArticleRow);
}

/** Update the classification fields for an existing article row. */
export async function updateArticleClassification(
  env: Env,
  id: number,
  patch: { category: Category; isKentucky: boolean; isNational?: boolean; county: string | null; counties?: string[] },
): Promise<void> {
  const normalizedCounty = normalizeCountyName(patch.county);

  // D1's remote prepared-statement cache was poisoned during migration 0009
  // (articles → articles_old → articles). Any prepare().bind().run() call that
  // shares its stripped-SQL cache key with a statement compiled during that
  // window fails with "no such table: main.articles_old" even though the table
  // doesn't exist anymore.
  //
  // env.ky_news_db.exec() uses the same raw-execution path as
  // `wrangler d1 execute --command` (confirmed working) and completely bypasses
  // the prepared-statement cache.  All inputs are validated before this point
  // so inlining literals is safe.
  const escStr = (v: string | null): string =>
    v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`;
  const rawSql =
    `UPDATE articles SET ` +
    `category = ${escStr(patch.category)}, ` +
    `is_kentucky = ${patch.isKentucky ? 1 : 0}, ` +
    `is_national = ${patch.isNational ? 1 : 0}, ` +
    `county = ${escStr(normalizedCounty)}, ` +
    `updated_at = CURRENT_TIMESTAMP ` +
    `WHERE id = ${id}`;

  await env.ky_news_db.exec(rawSql);

  // Build the full county sync as a single exec() batch so no prepare() calls
  // touch the poisoned D1 statement cache at all.
  let countiesList: string[] = [];
  if (patch.counties && patch.counties.length > 0) {
    countiesList = patch.counties
      .map((c) => normalizeCountyName(c))
      .filter((c): c is string => !!c);
  } else if (normalizedCounty) {
    countiesList = [normalizedCounty];
  }

  // Delete + re-insert via exec() — bypasses prepared-statement cache entirely.
  const stmts: string[] = [`DELETE FROM article_counties WHERE article_id = ${id}`];
  for (const county of countiesList) {
    const isPrimary = county === normalizedCounty ? 1 : 0;
    stmts.push(
      `INSERT OR IGNORE INTO article_counties (article_id, county, is_primary) ` +
      `VALUES (${id}, ${escStr(county)}, ${isPrimary})`,
    );
  }
  await env.ky_news_db.exec(stmts.join('; '));
}

function normalizeCountyName(value: string | null): string | null {
  if (!value) return null;
  const normalized = normalizeCountyList([value]);
  return (normalized[0] as string) ?? null;
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
  const rows = await prepare(env, query).bind(...binds).all<ArticleRow>();
  const mapped = (rows.results ?? []).map(mapArticleRow);

  for (const item of mapped) {
    if (item && typeof item.id === 'number') {
      item.counties = await getArticleCounties(env, item.id);
    }
  }

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
  const rows = await prepare(env,
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
  await prepare(env,
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

  await prepare(env, 'CREATE INDEX IF NOT EXISTS idx_blocked_articles_hash ON blocked_articles(url_hash)')
    .run();
}
