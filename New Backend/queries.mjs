/**
 * API Query Helpers v2
 *
 * Query builder for each page type with full support for:
 *  - County filtering (any county in selection)
 *  - Breaking news surfaced first
 *  - Paywalled articles sorted after free (with deprioritized last)
 *  - Duplicate articles suppressed (is_duplicate=0 unless showing all sources)
 *  - Bing fallback articles sorted after real local sources
 *  - Short articles rejected in body-worker excluded
 *  - School events query (structured calendar data)
 *  - Legislature bill articles query
 *
 * Usage:
 *   import { queryForPage, schoolEventsQuery } from './queries.mjs';
 *   const { sql, params } = queryForPage('sports', { counties: ['Fayette'], limit: 20 });
 *   const rows = await db.prepare(sql).all(params);
 */

/**
 * Core article query builder.
 *
 * @param {object} opts
 * @param {string}   opts.category         - page category
 * @param {string[]} opts.counties         - county filter (OR match)
 * @param {number}   opts.limit
 * @param {number}   opts.offset
 * @param {string}   opts.since            - ISO date filter
 * @param {boolean}  opts.includeDuplicates - show wire-service duplicates (default false)
 * @param {boolean}  opts.includePaywalled  - include paywalled (default true, sorted after free)
 * @param {boolean}  opts.breakingFirst     - breaking news at top (default true)
 */
export function queryForPage(category, opts = {}) {
  const {
    counties = [],
    limit = 40,
    offset = 0,
    since = null,
    includeDuplicates = false,
    includePaywalled = true,
    breakingFirst = true,
  } = opts;

  const isNational = category === "national";
  const regionClause = isNational ? `i.region_scope = 'national'` : `i.region_scope = 'ky'`;

  const categoryClause = `EXISTS (
    SELECT 1 FROM item_categories ic
    WHERE ic.item_id = i.id AND ic.category = @category
  )`;

  // County filter
  let countyClause = "";
  const countyParams = {};
  if (!isNational && counties.length > 0) {
    const phs = counties.map((_, idx) => `@county${idx}`).join(", ");
    countyClause = `AND EXISTS (
      SELECT 1 FROM item_locations il
      WHERE il.item_id = i.id AND il.state_code = 'KY' AND il.county IN (${phs})
    )`;
    counties.forEach((c, idx) => { countyParams[`county${idx}`] = c; });
  }

  const sinceClause = since ? `AND i.published_at >= @since` : "";

  // Exclude rejected-short items
  const qualityClause = `AND NOT EXISTS (
    SELECT 1 FROM ingestion_queue q
    WHERE q.item_id = i.id AND q.status = 'rejected_short'
  )`;

  // Suppress wire-service duplicates (show canonical only)
  const dedupClause = includeDuplicates ? "" : `AND i.is_duplicate = 0`;

  // Paywall filter
  const paywallClause = includePaywalled ? "" : `AND i.is_paywalled = 0`;

  // Sort order:
  //  1. Breaking & not expired (if breakingFirst)
  //  2. Non-paywalled before paywalled
  //  3. Bing fallback last
  //  4. Published date desc
  //  5. Deprioritized last within paywalled
  const breakingSort = breakingFirst
    ? `CASE WHEN i.is_breaking = 1 AND (i.breaking_expires_at IS NULL OR i.breaking_expires_at > datetime('now')) THEN 0 ELSE 1 END ASC,`
    : "";

  const ORDER_BY = `
    ${breakingSort}
    CASE WHEN i.paywall_deprioritized = 1 THEN 2
         WHEN i.is_paywalled = 1 THEN 1
         ELSE 0 END ASC,
    CASE WHEN EXISTS(
      SELECT 1 FROM feed_items fi JOIN feeds f ON fi.feed_id = f.id
      WHERE fi.item_id = i.id AND f.is_bing_fallback = 1
    ) THEN 1 ELSE 0 END ASC,
    i.published_at DESC NULLS LAST,
    i.fetched_at DESC
  `;

  const sql = `
    SELECT
      i.id,
      i.title,
      i.url,
      i.author,
      i.region_scope,
      i.published_at,
      i.image_url,
      i.word_count,
      i.is_facebook,
      i.is_paywalled,
      i.paywall_deprioritized,
      i.is_duplicate,
      i.is_breaking,
      i.alert_level,
      i.sentiment,
      i.breaking_expires_at,
      i.categories_json,
      COALESCE(i.ai_summary, i.summary) AS summary,
      i.ai_meta_description                AS meta_description,
      (
        SELECT GROUP_CONCAT(il.county, ', ')
        FROM item_locations il
        WHERE il.item_id = i.id AND il.county != ''
      ) AS counties,
      (
        SELECT GROUP_CONCAT(ab.bill_number, ', ')
        FROM article_bills ab
        WHERE ab.item_id = i.id
      ) AS bill_mentions,
      EXISTS(
        SELECT 1 FROM feed_items fi JOIN feeds f ON fi.feed_id=f.id
        WHERE fi.item_id = i.id AND f.is_bing_fallback = 1
      ) AS is_bing_source
    FROM items i
    WHERE ${regionClause}
      AND ${categoryClause}
      ${countyClause}
      ${sinceClause}
      ${qualityClause}
      ${dedupClause}
      ${paywallClause}
    ORDER BY ${ORDER_BY}
    LIMIT @limit OFFSET @offset
  `;

  return {
    sql,
    params: {
      category,
      limit,
      offset,
      ...(since ? { since } : {}),
      ...countyParams,
    },
  };
}

// ─── Page convenience wrappers ────────────────────────────────────────────────

export const todayQuery       = (opts = {}) => queryForPage("today",       opts);
export const nationalQuery    = (opts = {}) => queryForPage("national",    { ...opts, counties: [] });
export const sportsQuery      = (opts = {}) => queryForPage("sports",      opts);
export const weatherQuery     = (opts = {}) => queryForPage("weather",     opts);
export const schoolsQuery     = (opts = {}) => queryForPage("schools",     opts);
export const obituariesQuery  = (opts = {}) => queryForPage("obituaries",  opts);
export const legislatureQuery = (opts = {}) => queryForPage("legislature", opts);

// ─── School events (calendar) ─────────────────────────────────────────────────

export function schoolEventsQuery(counties = [], limit = 50) {
  if (counties.length === 0) {
    return {
      sql: `SELECT * FROM school_events WHERE start_at >= datetime('now', '-1 day')
            ORDER BY start_at ASC LIMIT @limit`,
      params: { limit },
    };
  }
  const phs = counties.map((_, i) => `@c${i}`).join(", ");
  const params = { limit };
  counties.forEach((c, i) => { params[`c${i}`] = c; });
  return {
    sql: `SELECT * FROM school_events
          WHERE county IN (${phs}) AND start_at >= datetime('now', '-1 day')
          ORDER BY start_at ASC LIMIT @limit`,
    params,
  };
}

// ─── Breaking news ticker ─────────────────────────────────────────────────────

export const BREAKING_TICKER_SQL = `
  SELECT id, title, url, alert_level, counties, published_at, breaking_expires_at
  FROM items
  WHERE is_breaking = 1
    AND (breaking_expires_at IS NULL OR breaking_expires_at > datetime('now'))
    AND region_scope = 'ky'
  ORDER BY
    CASE alert_level WHEN 'emergency' THEN 0 WHEN 'breaking' THEN 1 ELSE 2 END,
    published_at DESC
  LIMIT 10
`;

// ─── Coverage report SQL ──────────────────────────────────────────────────────

export const COUNTY_COVERAGE_SQL = `
  SELECT
    il.county,
    COUNT(DISTINCT i.id)                                              AS article_count,
    MAX(i.published_at)                                               AS latest_article,
    SUM(CASE WHEN i.is_paywalled = 1 THEN 1 ELSE 0 END)             AS paywalled_count,
    SUM(CASE WHEN i.is_duplicate = 1 THEN 1 ELSE 0 END)             AS duplicate_count,
    SUM(CASE WHEN i.is_breaking  = 1 THEN 1 ELSE 0 END)             AS breaking_count
  FROM item_locations il
  JOIN items i ON i.id = il.item_id
  WHERE il.state_code = 'KY'
    AND il.county != ''
    AND i.published_at >= datetime('now', '-7 days')
  GROUP BY il.county
  ORDER BY article_count DESC
`;

// ─── Example Fastify route ────────────────────────────────────────────────────
/*
app.get('/api/articles', async (req) => {
  const page             = req.query.page             || 'today';
  const counties         = req.query.counties?.split(',').filter(Boolean) || [];
  const limit            = Math.min(Number(req.query.limit  || 40), 100);
  const offset           = Number(req.query.offset || 0);
  const since            = req.query.since || null;
  const includeDuplicates = req.query.dupes === 'true';
  const includePaywalled  = req.query.paywalled !== 'false';

  const { sql, params } = queryForPage(page, {
    counties, limit, offset, since, includeDuplicates, includePaywalled
  });
  return db.prepare(sql).all(params);
});

app.get('/api/events', async (req) => {
  const counties = req.query.counties?.split(',').filter(Boolean) || [];
  const { sql, params } = schoolEventsQuery(counties);
  return db.prepare(sql).all(params);
});

app.get('/api/breaking', async (req) => {
  return db.prepare(BREAKING_TICKER_SQL).all();
});
*/
