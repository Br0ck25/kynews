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
export function prepare(env: Env, sql: string) {
  const uniqueSql = `${sql} /* cache_bust_${Math.random()} */`;
  return env.ky_news_db.prepare(uniqueSql);
}

export async function findArticleByHash(env: Env, urlHash: string): Promise<ArticleRecord | null> {
  const result = await prepare(env, `SELECT * FROM articles WHERE url_hash = ? LIMIT 1`)
    .bind(urlHash)
    .first<ArticleRow>();

  return result ? mapArticleRow(result) : null;
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

  if (!result) return null;
  const article = mapArticleRow(result);
  // populate counties array for single‑article fetches so clients can display
  // secondary counties.  queryArticles already handles this, but the slug/id
  // endpoints previously returned an empty list, which is why multi‑county
  // tags were lost on the article detail page.
  article.counties = await getArticleCounties(env, article.id);
  return article;
}

export async function getArticleBySlug(env: Env, slug: string): Promise<ArticleRecord | null> {
  const result = await prepare(env, `SELECT * FROM articles WHERE slug = ? LIMIT 1`)
    .bind(slug)
    .first<ArticleRow>();

  if (!result) return null;
  const article = mapArticleRow(result);
  article.counties = await getArticleCounties(env, article.id);
  return article;
}

// when new articles are added or existing ones are modified we need to
// keep the RSS feed cache fresh.  The feed generator includes a small
// version string in the cache key; bumping that value causes every cache
// lookup to miss and forces regeneration.  We deliberately avoid trying to
// enumerate all possible county-specific keys (the Cache API doesn't offer a
// way to list or delete by prefix), so a simple version stamp is the easiest
// way to invalidate everything at once.
async function bumpRssVersion(env: Env): Promise<void> {
  if (!env.CACHE) return;
  try {
    // use a timestamp; the actual value isn't important as long as it
    // changes.  tests inspect and delete this key as well.
    await env.CACHE.put('rss:today-version', Date.now().toString());
  } catch {
    // ignore cache errors
  }
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

    // Invalidate the RSS cache so the new article appears immediately
    await bumpRssVersion(env);

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
  maxAgeHours: number = 48,
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
       LIMIT 200`
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
  await bumpRssVersion(env);
}

export async function updateArticleContent(
  env: Env,
  id: number,
  patch: { title?: string; summary?: string; imageUrl?: string | null },
): Promise<void> {
  // modifying the content should also invalidate the feed.
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

  if (patch.imageUrl !== undefined) {
    sets.push('image_url = ?');
    // allow null or trimmed string
    binds.push(patch.imageUrl ? patch.imageUrl.trim().slice(0, 2000) : null);
  }

  if (sets.length === 1) return;
  binds.push(id);

  await prepare(env, `UPDATE articles SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();

  await bumpRssVersion(env);
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
  await bumpRssVersion(env);
}

export async function deleteArticleById(env: Env, id: number): Promise<void> {
  // Fetch the article before deleting so we can clear its KV caches.
  // Without this, re-ingesting a deleted article hits the content fingerprint
  // dedup cache and returns "already in database" even though D1 has no row.
  const article = await prepare(env,
    'SELECT url_hash, content_text FROM articles WHERE id = ? LIMIT 1'
  ).bind(id).first<{ url_hash: string; content_text: string }>();

  await prepare(env, 'DELETE FROM articles WHERE id = ?').bind(id).run();
  await bumpRssVersion(env);

  if (article && env.CACHE) {
    const { sha256Hex } = await import('./http');

    // Clear content fingerprint (first 150 words hash) so the article can be re-ingested
    if (article.content_text) {
      const fingerprint = await sha256Hex(
        article.content_text.split(/\s+/).slice(0, 150).join(' ').toLowerCase()
      ).catch(() => null);
      if (fingerprint) {
        await env.CACHE.delete(`cfp:${fingerprint}`).catch(() => {});
      }
    }

    // Clear summary cache keyed by url_hash
    if (article.url_hash) {
      await env.CACHE.delete(`summary:${article.url_hash}`).catch(() => {});
      await env.CACHE.delete(`summary-ttl:${article.url_hash}`).catch(() => {});
      await env.CACHE.delete(`feedback:${article.url_hash}`).catch(() => {});
    }
  }
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
  await bumpRssVersion(env);
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

/**
 * Efficiently fetch counties for multiple articles in a single query.
 * Returns a map from article id to array of county names (primary first).
 */
export async function getArticleCountiesBatch(
  env: Env,
  articleIds: number[],
): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>();
  if (articleIds.length === 0) return map;

  const placeholders = articleIds.map(() => '?').join(',');
  const rows = await prepare(env,
      `SELECT article_id, county FROM article_counties
       WHERE article_id IN (${placeholders})
       ORDER BY is_primary DESC, article_id`,
    )
    .bind(...articleIds)
    .all<{ article_id: number; county: string }>();

  for (const r of rows.results ?? []) {
    if (!map.has(r.article_id)) map.set(r.article_id, []);
    map.get(r.article_id)!.push(r.county);
  }

  return map;
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
  /**
   * when true we ignore the normal "is_kentucky = 1" restriction that
   * applies to the "today" category.  callers such as the RSS generator use
   * this so that non‑Kentucky stories are still included.
   */
  includeNonKentucky?: boolean;
}): Promise<ArticleListResponse> {
  const where: string[] = [];
  const binds: unknown[] = [];

  if (options.category === 'all') {
    // special case: no category filter, return articles from every bucket
  } else if (options.category === 'today') {
    // Always restrict to category = 'today'; the includeNonKentucky flag only
    // controls whether we also require is_kentucky = 1 on top of that.
    where.push('category = ?');
    binds.push('today');
    if (!options.includeNonKentucky) {
      where.push('is_kentucky = 1');
    }
  } else if (options.category === 'national') {
    // include rows whose category is explicitly "national" or that have the
    // national flag set.  this allows admins to flip a story to national without
    // remembering to change its category as well.
    const supportsIsNational = await columnExists(env, 'articles', 'is_national');
    if (supportsIsNational) {
      where.push('((category = ?) OR (is_national = 1))');
      binds.push('national');
    } else {
      // legacy schemas without the flag use category only
      where.push('category = ?');
      binds.push('national');
    }
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
    // use EXISTS against the junction table so that any row tagged with the
    // requested county (primary or secondary) qualifies.  legacy rows that
    // haven't been backfilled into article_counties are still covered by the
    // fallback `county IN` check.
    const placeholders = options.counties.map(() => '?').join(',');
    where.push(`(
      EXISTS (
        SELECT 1 FROM article_counties ac
        WHERE ac.article_id = articles.id
          AND ac.county IN (${placeholders})
      )
      OR county IN (${placeholders})
    )`);
    // bind once for the EXISTS clause and once for the direct-column fallback
    binds.push(...options.counties, ...options.counties);
  }

  if (options.search) {
    // allow searching title, summary or full article text; previously only
    // summary was indexed which meant matches buried in the body would never
    // surface.  including content_text makes searches more intuitive at the
    // cost of a slightly wider table scan.
    where.push('(title LIKE ? OR summary LIKE ? OR content_text LIKE ?)');
    const token = `%${escapeLike(options.search)}%`;
    binds.push(token, token, token);
  }

  if (options.cursor) {
    where.push('id < ?');
    binds.push(Number.parseInt(options.cursor, 10) || Number.MAX_SAFE_INTEGER);
  }

  // Never surface articles scheduled in the future on public endpoints.
  where.push('published_at <= ?');
  binds.push(new Date().toISOString());

  const sqlLimit = Math.min((options.limit * 3) + 5, 300);
  binds.push(sqlLimit);

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : 'WHERE 1=1';
  const query = `SELECT * FROM articles ${whereClause} ORDER BY published_at DESC, id DESC LIMIT ?`;

  const rows = await prepare(env, query).bind(...binds).all<ArticleRow>();
  const mapped = (rows.results ?? []).map(mapArticleRow);

  // Attach county lists in one go rather than hitting DB for each item.
  if (mapped.length > 0) {
    const ids = mapped.map((a) => a.id);
    const countiesMap = await getArticleCountiesBatch(env, ids);
    for (const article of mapped) {
      article.counties = countiesMap.get(article.id) || [];
    }
  }

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
    contentHash: row.content_hash ?? null,
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
  // reclassification should also bump the RSS cache version
  const normalizedCounty = normalizeCountyName(patch.county);

  // When the caller doesn't provide `isNational` we want to preserve the
  // existing value instead of blindly setting it to `0`.  The old behavior
  // treated `undefined` as `false`, which could clear a previously-tagged
  // national article when the admin only edited the category or Kentucky flag.
  // Using COALESCE allows us to conditionally update the column only when a
  // value is supplied.
  const doUpdate = () =>
    prepare(
      env,
      'UPDATE articles SET category = ?, is_kentucky = ?, is_national = COALESCE(?, is_national), county = ? WHERE id = ?',
    )
      .bind(
        patch.category,
        patch.isKentucky ? 1 : 0,
        patch.isNational === undefined ? null : patch.isNational ? 1 : 0,
        normalizedCounty,
        id,
      )
      .run();

  try {
    await doUpdate();
  } catch (err: any) {
    if (err?.message?.includes('articles_old')) {
      console.warn(`[RETAG] Stale cache detected for article ${id}, retrying with forced fresh SQL...`);
      await doUpdate();
    } else {
      throw err;
    }
  }

  let countiesList: string[] = [];
  if (patch.counties && patch.counties.length > 0) {
    countiesList = patch.counties
      .map((c) => normalizeCountyName(c))
      .filter((c): c is string => !!c);
  } else if (normalizedCounty) {
    countiesList = [normalizedCounty];
  }

  await prepare(env, 'DELETE FROM article_counties WHERE article_id = ?')
    .bind(id)
    .run();

  for (const county of countiesList) {
    try {
        await prepare(env, `INSERT OR IGNORE INTO article_counties (article_id, county, is_primary)
             VALUES (?, ?, ?)`)
          .bind(id, county, county === normalizedCounty ? 1 : 0)
          .run();
    } catch (e) {
        console.error(`[RETAG] Failed to insert county ${county} for article ${id}`, e);
    }
  }

  await bumpRssVersion(env);
}

/**
 * Update only the primary county of an article without disturbing the
 * existing set of secondary counties.  Returns the updated article record
 * (including a fresh `counties` array) or null if the article does not exist.
 */
export async function updateArticlePrimaryCounty(
  env: Env,
  id: number,
  county: string | null,
): Promise<ArticleRecord | null> {
  // changing the primary county can affect which county-specific feeds
  // include the article
  const normalizedCounty = normalizeCountyName(county);

  // update the article row; we do not mutate is_kentucky here unless
  // clearing the last county.
  await prepare(env, 'UPDATE articles SET county = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(normalizedCounty, id)
    .run();

  if (normalizedCounty === null) {
    // clear any existing primary flag on the junction
    await prepare(env, 'UPDATE article_counties SET is_primary = 0 WHERE article_id = ?')
      .bind(id)
      .run();
    // if there are no counties left at all, demote is_kentucky
    const row = await prepare(env, 'SELECT COUNT(*) as cnt FROM article_counties WHERE article_id = ?')
      .bind(id)
      .first<{ cnt: number }>();
    if ((row?.cnt ?? 0) === 0) {
      await prepare(env, 'UPDATE articles SET is_kentucky = 0 WHERE id = ?')
        .bind(id)
        .run();
    }
  } else {
    // remove primary from all counties, then mark or insert the requested one
    await prepare(env, 'UPDATE article_counties SET is_primary = 0 WHERE article_id = ?')
      .bind(id)
      .run();
    const exists = await prepare(env, 'SELECT 1 FROM article_counties WHERE article_id = ? AND county = ?')
      .bind(id, normalizedCounty)
      .first();
    if (exists) {
      await prepare(env, 'UPDATE article_counties SET is_primary = 1 WHERE article_id = ? AND county = ?')
        .bind(id, normalizedCounty)
        .run();
    } else {
      await prepare(env, 'INSERT INTO article_counties (article_id, county, is_primary) VALUES (?, ?, 1)')
        .bind(id, normalizedCounty)
        .run();
    }
  }

  const result = await getArticleById(env, id);
  await bumpRssVersion(env);
  return result;
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
    where.push('(title LIKE ? OR summary LIKE ? OR source_url LIKE ? OR county LIKE ?)');
    const token = `%${escapeLike(options.search)}%`;
    binds.push(token, token, token, token);
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
