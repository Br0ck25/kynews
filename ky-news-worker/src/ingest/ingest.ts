import { d1All, d1First, d1Run } from "../services/db";
import { parseFeedItems } from "../services/rss";
import { scrapeFeedItems, scrapeFacebookPageItems } from "../services/scrapers";
import { detectKyCounties, detectKyCountiesFromCityHints } from "../services/location";
import { fetchArticle } from "../services/article";
import { getCachedSeoDescription, getCachedSummary, generateSummaryWithAI } from "../services/summary";
import { mirrorArticleImageToR2 } from "../services/media";
import { isKentuckyRelevant } from "../services/relevance";
import { makeItemId, stableHash } from "../lib/crypto";
import { normalizeCounty } from "../lib/utils";
import { decodeHtmlEntities, toHttpsUrl } from "../lib/text";
import { logError, logInfo, logWarn } from "../lib/logger";
import type { Env } from "../types";
import { incrementMetricGroup, writeStructuredLog } from "../services/observability";

const FEED_TIMEOUT_MS = 15_000;
const MIN_ARTICLE_WORDS = 50;
const LOCATION_TAG_CHAR_LIMIT = 3_500;

type FeedRow = {
  id: string;
  name: string;
  url: string;
  fetch_mode: string | null;
  scraper_id: string | null;
  etag: string | null;
  last_modified: string | null;
  state_code: string | null;
  region_scope: string | null;
  default_county: string | null;
};

type IngestOptions = {
  source: "cron" | "manual" | "manual-feed";
  force?: boolean;
  maxFeeds?: number;
  maxItemsPerFeed?: number;
  feedIds?: string[];
};

export type IngestRunResult = {
  runId: number | null;
  source: "cron" | "manual" | "manual-feed";
  status: "ok" | "failed";
  startedAt: string;
  finishedAt: string;
  feedsProcessed: number;
  feedsUpdated: number;
  itemsSeen: number;
  itemsUpserted: number;
  summariesGenerated: number;
  imagesMirrored: number;
  errors: number;
  feedErrors: Array<{ feedId: string; error: string }>;
  feedMetrics: Array<{
    feedId: string;
    status: "ok" | "error" | "not_modified";
    httpStatus: number | null;
    durationMs: number;
    itemsSeen: number;
    itemsUpserted: number;
    errorMessage?: string;
  }>;
};

function toIsoOrNull(dateLike: string | null | undefined): string | null {
  if (!dateLike) return null;
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_eid$|mkt_tok$)/i.test(key)) {
        u.searchParams.delete(key);
      }
    }
    u.hash = "";
    const path = u.pathname.replace(/\/+$/, "");
    u.pathname = path || "/";
    return u.toString();
  } catch {
    return url;
  }
}

function textOnly(input: string | null | undefined): string {
  return decodeHtmlEntities(String(input || ""))
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textWordCount(input: string | null | undefined): number {
  return String(input || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

async function removeLowWordItem(
  env: Env,
  feedId: string,
  itemId: string
): Promise<void> {
  await d1Run(env.ky_news_db, "DELETE FROM feed_items WHERE feed_id=? AND item_id=?", [feedId, itemId]);
  const remaining = await d1First<{ refs: number }>(
    env.ky_news_db,
    "SELECT COUNT(1) AS refs FROM feed_items WHERE item_id=?",
    [itemId]
  );
  if (Number(remaining?.refs || 0) <= 0) {
    await d1Run(env.ky_news_db, "DELETE FROM items WHERE id=?", [itemId]);
  }
}

async function fetchWithConditional(
  url: string,
  etag: string | null,
  lastModified: string | null,
  force: boolean,
  userAgent: string
): Promise<{ status: number; etag: string | null; lastModified: string | null; text: string | null }> {
  const headers = new Headers();
  headers.set("accept", "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8");
  headers.set("user-agent", userAgent);

  if (!force) {
    if (etag) headers.set("If-None-Match", etag);
    if (lastModified) headers.set("If-Modified-Since", lastModified);
  }

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), FEED_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers,
      signal: ctrl.signal,
      redirect: "follow",
      cf: { cacheTtl: 0 }
    });

    if (res.status === 304) {
      return { status: 304, etag, lastModified, text: null };
    }

    if (res.status < 200 || res.status >= 300) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} for ${url} :: ${body.slice(0, 220)}`);
    }

    const nextEtag = res.headers.get("etag") || etag || null;
    const nextLast = res.headers.get("last-modified") || lastModified || null;
    const text = await res.text();

    return { status: res.status, etag: nextEtag, lastModified: nextLast, text };
  } finally {
    clearTimeout(timeout);
  }
}

async function recordError(env: Env, feedId: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? `${err.message}\n${err.stack || ""}` : String(err);
  await d1Run(env.ky_news_db, "INSERT INTO fetch_errors (feed_id, at, error) VALUES (?, datetime('now'), ?)", [
    feedId,
    message.slice(0, 4000)
  ]);
}

async function startRun(env: Env, source: "cron" | "manual" | "manual-feed"): Promise<number | null> {
  const run = await d1Run(
    env.ky_news_db,
    "INSERT INTO fetch_runs (started_at, status, source) VALUES (datetime('now'), 'running', ?)",
    [source]
  );

  const runId = (run.meta as any)?.last_row_id;
  return typeof runId === "number" ? runId : null;
}

async function finishRun(env: Env, runId: number | null, status: "ok" | "failed", details: unknown): Promise<void> {
  if (runId == null) return;
  await d1Run(
    env.ky_news_db,
    "UPDATE fetch_runs SET finished_at=datetime('now'), status=?, details_json=? WHERE id=?",
    [status, JSON.stringify(details), runId]
  );
}

async function recordFeedMetric(
  env: Env,
  input: {
    runId: number | null;
    source: string;
    feedId: string;
    status: "ok" | "error" | "not_modified";
    httpStatus: number | null;
    durationMs: number;
    itemsSeen: number;
    itemsUpserted: number;
    errorMessage?: string;
  }
): Promise<void> {
  await d1Run(
    env.ky_news_db,
    `
    INSERT INTO feed_run_metrics (
      run_id, feed_id, source, status, http_status, duration_ms, items_seen, items_upserted, error_message, checked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `,
    [
      input.runId,
      input.feedId,
      input.source,
      input.status,
      input.httpStatus,
      input.durationMs,
      input.itemsSeen,
      input.itemsUpserted,
      input.errorMessage || null
    ]
  );
}

async function recordRunMetrics(env: Env, result: IngestRunResult): Promise<void> {
  await d1Run(
    env.ky_news_db,
    `
    INSERT INTO ingestion_metrics (
      run_id, source, status, feeds_processed, feeds_updated, items_seen, items_upserted,
      summaries_generated, images_mirrored, errors, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `,
    [
      result.runId,
      result.source,
      result.status,
      result.feedsProcessed,
      result.feedsUpdated,
      result.itemsSeen,
      result.itemsUpserted,
      result.summariesGenerated,
      result.imagesMirrored,
      result.errors
    ]
  );

  await incrementMetricGroup(env, "ingestion", {
    runs: 1,
    feedsProcessed: result.feedsProcessed,
    feedsUpdated: result.feedsUpdated,
    itemsSeen: result.itemsSeen,
    itemsUpserted: result.itemsUpserted,
    summariesGenerated: result.summariesGenerated,
    imagesMirrored: result.imagesMirrored,
    errors: result.errors
  });
}

async function upsertItemAndLink(
  env: Env,
  feedId: string,
  row: {
    id: string;
    title: string;
    url: string;
    guid: string | null;
    author: string | null;
    region_scope: "ky" | "national";
    published_at: string | null;
    summary: string | null;
    content: string | null;
    image_url: string | null;
    hash: string;
  }
): Promise<"inserted" | "updated" | "unchanged"> {
  const existing = await d1First<{ hash: string | null }>(env.ky_news_db, "SELECT hash FROM items WHERE id=?", [row.id]);

  if (existing?.hash && existing.hash === row.hash) {
    await d1Run(env.ky_news_db, "INSERT OR IGNORE INTO feed_items (feed_id, item_id) VALUES (?, ?)", [feedId, row.id]);
    return "unchanged";
  }

  await d1Run(
    env.ky_news_db,
    `
    INSERT INTO items (id, title, url, guid, author, region_scope, published_at, summary, content, image_url, hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,
      author=excluded.author,
      region_scope=excluded.region_scope,
      published_at=excluded.published_at,
      summary=COALESCE(excluded.summary, items.summary),
      content=COALESCE(excluded.content, items.content),
      image_url=COALESCE(excluded.image_url, items.image_url),
      hash=excluded.hash
    `,
    [
      row.id,
      row.title,
      row.url,
      row.guid,
      row.author,
      row.region_scope,
      row.published_at,
      row.summary,
      row.content,
      row.image_url,
      row.hash
    ]
  );

  await d1Run(env.ky_news_db, "INSERT OR IGNORE INTO feed_items (feed_id, item_id) VALUES (?, ?)", [feedId, row.id]);
  return existing ? "updated" : "inserted";
}

type PreparedKyRelevance = {
  relevant: boolean;
  failedTier: string | null;
  failedStage: "rss_only" | "readability_body" | null;
  excerpt: string;
  imageCandidate: string | null;
  publishedAt: string | null;
  fetchStatus: string | null;
  locationBodyText: string;
};

async function prepareKentuckyRelevance(
  env: Env,
  input: {
    itemId: string;
    stateCode: string;
    title: string;
    description: string | null;
    url: string;
  }
): Promise<PreparedKyRelevance> {
  const st = (input.stateCode || "KY").toUpperCase();
  const textToCheck = [input.title, input.description].filter(Boolean).join(" ");
  const normalizedRssText = textOnly(textToCheck);

  if (st !== "KY") {
    return {
      relevant: true,
      failedTier: null,
      failedStage: null,
      excerpt: "",
      imageCandidate: null,
      publishedAt: null,
      fetchStatus: null,
      locationBodyText: normalizedRssText
    };
  }

  const rssRelevance = isKentuckyRelevant(input.title, normalizedRssText);
  if (!rssRelevance.relevant) {
    return {
      relevant: false,
      failedTier: rssRelevance.failedTier,
      failedStage: "rss_only",
      excerpt: "",
      imageCandidate: null,
      publishedAt: null,
      fetchStatus: null,
      locationBodyText: normalizedRssText
    };
  }

  const meta = await d1First<{
    article_checked_at: string | null;
    article_text_excerpt: string | null;
    image_url: string | null;
    published_at: string | null;
  }>(
    env.ky_news_db,
    "SELECT article_checked_at, article_text_excerpt, image_url, published_at FROM items WHERE id=?",
    [input.itemId]
  );

  const alreadyChecked = Boolean(meta?.article_checked_at);
  const existingExcerpt = textOnly(meta?.article_text_excerpt || "");
  const needsImage = !String(meta?.image_url || "").trim() || /^https?:\/\//i.test(String(meta?.image_url || ""));
  const needsPublishedDate = !String(meta?.published_at || "").trim();
  const shouldFetchArticle = Boolean(input.url && !alreadyChecked && (needsImage || existingExcerpt.length < 300 || needsPublishedDate));

  let excerpt = existingExcerpt;
  let imageCandidate: string | null = null;
  let publishedAt: string | null = null;
  let fetchStatus: string | null = null;

  if (shouldFetchArticle) {
    const fetched = await fetchArticle(input.url);
    fetchStatus = fetched.status;
    const cleanText = textOnly(fetched.text || "");
    if (cleanText) {
      const readableRelevance = isKentuckyRelevant(input.title, cleanText);
      if (!readableRelevance.relevant) {
        return {
          relevant: false,
          failedTier: readableRelevance.failedTier,
          failedStage: "readability_body",
          excerpt: cleanText,
          imageCandidate: fetched.ogImage || null,
          publishedAt: fetched.publishedAt || null,
          fetchStatus,
          locationBodyText: cleanText
        };
      }
      excerpt = cleanText;
    }
    imageCandidate = fetched.ogImage || null;
    publishedAt = fetched.publishedAt || null;
  }

  return {
    relevant: true,
    failedTier: null,
    failedStage: null,
    excerpt,
    imageCandidate,
    publishedAt,
    fetchStatus,
    locationBodyText: textOnly(excerpt || normalizedRssText)
  };
}

async function persistFetchedArticleData(
  env: Env,
  input: {
    itemId: string;
    fetchStatus: string | null;
    excerpt: string;
    imageCandidate: string | null;
    publishedAt: string | null;
  }
): Promise<void> {
  if (!input.fetchStatus) return;

  const excerpt = input.excerpt ? input.excerpt : null;
  await d1Run(
    env.ky_news_db,
    `
    UPDATE items
    SET
      article_checked_at = datetime('now'),
      article_fetch_status = ?,
      article_text_excerpt = COALESCE(?, article_text_excerpt),
      published_at = COALESCE(published_at, ?),
      content = COALESCE(content, ?),
      image_url = COALESCE(image_url, ?)
    WHERE id=?
    `,
    [input.fetchStatus, excerpt, input.publishedAt || null, excerpt, input.imageCandidate || null, input.itemId]
  );
}

async function writeItemLocations(
  env: Env,
  input: {
    itemId: string;
    stateCode: string;
    title: string;
    bodyText: string;
    shouldTagState: boolean;
    /** When set, always tag this county regardless of article text analysis. */
    defaultCounty?: string | null;
    /**
     * When true, skip body-text county analysis entirely and rely only on
     * defaultCounty + title detection. Used for Facebook-page feeds where the
     * post body text is written from the school page's perspective and has no
     * location signals.
     */
    skipBodyAnalysis?: boolean;
  }
): Promise<void> {
  const st = (input.stateCode || "KY").toUpperCase();
  await d1Run(env.ky_news_db, "DELETE FROM item_locations WHERE item_id=? AND state_code=?", [input.itemId, st]);

  if (!input.shouldTagState) return;

  await d1Run(env.ky_news_db, "INSERT OR IGNORE INTO item_locations (item_id, state_code, county) VALUES (?, ?, '')", [
    input.itemId,
    st
  ]);

  if (st !== "KY") return;

  // Title counties are always reliable — include all of them.
  const titleCountyNames = detectKyCounties(input.title);
  const titleCountySet = new Set<string>(
    titleCountyNames.map((c) => normalizeCounty(c)).filter(Boolean)
  );

  const taggedCounties = new Set<string>(titleCountySet);

  // Always include the feed's default county if supplied (the feed is explicitly
  // scoped to that county so every article from it belongs there).
  if (input.defaultCounty) {
    const dc = normalizeCounty(input.defaultCounty);
    if (dc) taggedCounties.add(dc);
  }

  if (!input.skipBodyAnalysis) {
    const normalizedBody = textOnly(input.bodyText);
    const articleText = normalizedBody.length > LOCATION_TAG_CHAR_LIMIT
      ? normalizedBody.slice(0, LOCATION_TAG_CHAR_LIMIT)
      : normalizedBody;
    const bodyCountyCandidates = detectKyCounties(articleText);

    for (const county of bodyCountyCandidates) {
      const n = normalizeCounty(county);
      if (!n) continue;

      // Counties already confirmed by title or default_county are fine.
      if (taggedCounties.has(n)) continue;

      // For body-only detection: require 2+ explicit "County" mentions to avoid
      // false positives from passing references (e.g. sports schedules that list
      // other teams' counties).  City-name hints (one-mention) are intentionally
      // excluded here; they can produce false positives for common names.
      const countRe = new RegExp(
        `\\b${n.replace(/\s+/g, "\\\\s+")}\\s+(?:county|co\\.?)\\b`,
        "gi"
      );
      const mCount = (articleText.match(countRe) || []).length;
      if (mCount >= 2) {
        taggedCounties.add(n);
      }
    }

    // Additional city-based county tagging: when KY context is confirmed in the body,
    // map city mentions directly to their counties (single occurrence is sufficient).
    // This catches articles that mention e.g. "Hazard" or "Pikeville" without ever
    // writing "Perry County" or "Pike County" explicitly.
    const cityBasedCounties = detectKyCountiesFromCityHints(articleText);
    for (const county of cityBasedCounties) {
      const n = normalizeCounty(county);
      if (n && !taggedCounties.has(n)) {
        taggedCounties.add(n);
      }
    }
  }

  for (const county of taggedCounties) {
    await d1Run(
      env.ky_news_db,
      "INSERT OR IGNORE INTO item_locations (item_id, state_code, county) VALUES (?, ?, ?)",
      [input.itemId, st, county]
    );
  }
}

export async function ingestFeeds(env: Env, options: IngestOptions): Promise<IngestRunResult> {
  const startedAt = new Date().toISOString();
  const maxFeeds = Number(options.maxFeeds || env.MAX_FEEDS_PER_RUN || 200);
  const maxItemsPerFeed = Number(options.maxItemsPerFeed || env.MAX_INGEST_ITEMS_PER_FEED || 60);

  const summary: IngestRunResult = {
    runId: null,
    source: options.source,
    status: "ok",
    startedAt,
    finishedAt: startedAt,
    feedsProcessed: 0,
    feedsUpdated: 0,
    itemsSeen: 0,
    itemsUpserted: 0,
    summariesGenerated: 0,
    imagesMirrored: 0,
    errors: 0,
    feedErrors: [],
    feedMetrics: []
  };

  summary.runId = await startRun(env, options.source);

  try {
    const constrainedFeedIds = Array.isArray(options.feedIds) ? options.feedIds.filter(Boolean) : [];
    const rssUserAgent = env.RSS_USER_AGENT || "EKY-News-Bot/1.0 (+https://localkynews.com)";
    const feeds = constrainedFeedIds.length
      ? await d1All<FeedRow>(
          env.ky_news_db,
          `
          SELECT id, name, url, fetch_mode, scraper_id, etag, last_modified, state_code, region_scope, default_county
          FROM feeds
          WHERE enabled=1 AND id IN (${constrainedFeedIds.map(() => "?").join(",")})
          ORDER BY name
          `,
          constrainedFeedIds
        )
      : await d1All<FeedRow>(
          env.ky_news_db,
          `
          SELECT id, name, url, fetch_mode, scraper_id, etag, last_modified, state_code, region_scope, default_county
          FROM feeds
          WHERE enabled=1
          ORDER BY COALESCE(last_checked_at, '1970-01-01 00:00:00') ASC, name
          LIMIT ?
          `,
          [Number.isFinite(maxFeeds) ? maxFeeds : 200]
        );

    for (const feed of feeds) {
      summary.feedsProcessed += 1;
      const feedStarted = Date.now();
      let feedItemsSeen = 0;
      let feedItemsUpserted = 0;
      let feedHttpStatus: number | null = null;
      let feedStatus: "ok" | "error" | "not_modified" = "ok";
      let feedErrorMessage: string | undefined;
      try {
      const fetchMode = String(feed.fetch_mode || "rss").trim().toLowerCase();
        const safeMaxItems = Number.isFinite(maxItemsPerFeed) ? maxItemsPerFeed : 60;
        let parsedItems: ReturnType<typeof parseFeedItems> = [];
        // facebook-page feeds skip KY relevance + word-count checks — posts are
        // inherently local (county-scoped) and can be legitimately short.
        const isFacebookFeed = fetchMode === "facebook-page";

        if (isFacebookFeed) {
          const scraped = await scrapeFacebookPageItems({
            feedId: feed.id,
            feedName: feed.name,
            url: feed.url,
            scraperId: null,
            maxItems: safeMaxItems,
            userAgent: rssUserAgent,
            // Pass session cookie from env when configured for authenticated access.
            sessionCookie: env.FACEBOOK_SESSION_COOKIE || undefined
          });
          feedHttpStatus = scraped.status;
          parsedItems = scraped.items.slice(0, safeMaxItems);
          if (parsedItems.length > 0) {
            summary.feedsUpdated += 1;
          }
        } else if (fetchMode === "scrape") {
          const scraped = await scrapeFeedItems({
            feedId: feed.id,
            url: feed.url,
            scraperId: feed.scraper_id,
            maxItems: safeMaxItems,
            userAgent: rssUserAgent
          });
          feedHttpStatus = scraped.status;
          parsedItems = scraped.items.slice(0, safeMaxItems);
          if (parsedItems.length > 0) {
            summary.feedsUpdated += 1;
          }
        } else {
          const fetched = await fetchWithConditional(
            feed.url,
            feed.etag,
            feed.last_modified,
            Boolean(options.force),
            rssUserAgent
          );
          feedHttpStatus = fetched.status;

          await d1Run(
            env.ky_news_db,
            "UPDATE feeds SET etag=?, last_modified=?, last_checked_at=datetime('now') WHERE id=?",
            [fetched.etag, fetched.lastModified, feed.id]
          );

          if (fetched.status === 304 || !fetched.text) {
            feedStatus = "not_modified";
            continue;
          }

          summary.feedsUpdated += 1;
          parsedItems = parseFeedItems(fetched.text).slice(0, safeMaxItems);
        }

        for (const it of parsedItems) {
          summary.itemsSeen += 1;
          feedItemsSeen += 1;

          const publishedAt = toIsoOrNull(it.isoDate || it.pubDate);
          const link = canonicalUrl(it.link || it.guid || "");
          const title = (it.title || "").trim() || "(untitled)";
          const summaryText = textOnly(it.contentSnippet || "") || null;
          const contentText = textOnly(it.content || "") || null;
          const author = (it.author || "").trim() || null;
          const imageUrl = toHttpsUrl(it.imageUrl);

          const itemId = await makeItemId({ url: link, guid: it.guid, title, published_at: publishedAt });
          const hash = await stableHash(
            [title, link, summaryText || "", contentText || "", author || "", publishedAt || ""].join("|")
          );

          const isKyScope = (feed.region_scope || "ky") === "ky";
          let kyRelevance: PreparedKyRelevance | null = null;
          if (isKyScope && !isFacebookFeed) {
            // NOTE: Items tagged before this ingest-time relevance gate may need a one-time
            // backfill script to re-run isKentuckyRelevant() and refresh item_locations.
            // Facebook-page feeds are already county-scoped; skip relevance gating.
            kyRelevance = await prepareKentuckyRelevance(env, {
              itemId,
              stateCode: feed.state_code || "KY",
              title,
              description: summaryText,
              url: link
            });

            if (!kyRelevance.relevant) {
              logInfo("ingest.item.rejected_ky_relevance", {
                feedId: feed.id,
                itemId,
                title,
                failedTier: kyRelevance.failedTier || "tier2_body",
                failedStage: kyRelevance.failedStage || "rss_only"
              });
              await removeLowWordItem(env, feed.id, itemId);
              continue;
            }
          }

          const upserted = await upsertItemAndLink(env, feed.id, {
            id: itemId,
            title,
            url: link,
            guid: it.guid,
            author,
            region_scope: feed.region_scope === "national" ? "national" : "ky",
            published_at: publishedAt,
            summary: summaryText,
            content: contentText,
            image_url: imageUrl,
            hash
          });

          if (isKyScope) {
            if (kyRelevance) {
              await persistFetchedArticleData(env, {
                itemId,
                fetchStatus: kyRelevance.fetchStatus,
                excerpt: kyRelevance.excerpt,
                imageCandidate: kyRelevance.imageCandidate,
                publishedAt: kyRelevance.publishedAt
              });
            }
            await writeItemLocations(env, {
              itemId,
              stateCode: feed.state_code || "KY",
              title,
              bodyText: kyRelevance?.locationBodyText ?? (contentText || summaryText || ""),
              shouldTagState: true,
              defaultCounty: feed.default_county || null,
              skipBodyAnalysis: isFacebookFeed
            });
          }

          if (upserted === "unchanged") {
            // For Facebook-page feeds, never remove for low word count — posts are intentionally short.
            if (!isFacebookFeed) {
              const existingQuality = await d1First<{
                article_text_excerpt: string | null;
                content: string | null;
                summary: string | null;
              }>(
                env.ky_news_db,
                "SELECT article_text_excerpt, content, summary FROM items WHERE id=? LIMIT 1",
                [itemId]
              );
              const existingQualityText =
                kyRelevance?.excerpt ||
                existingQuality?.article_text_excerpt ||
                existingQuality?.content ||
                existingQuality?.summary ||
                "";
              if (textWordCount(existingQualityText) < MIN_ARTICLE_WORDS) {
                await removeLowWordItem(env, feed.id, itemId);
              }
            }
            continue;
          }

          let articleExcerpt = contentText || "";
          let articleImageCandidate = imageUrl;

          if (kyRelevance) {
            if (kyRelevance.excerpt && kyRelevance.excerpt.length > articleExcerpt.length) {
              articleExcerpt = kyRelevance.excerpt;
            }
            if (kyRelevance.imageCandidate) {
              articleImageCandidate = kyRelevance.imageCandidate;
            }
          }

          // Facebook-page posts are intentionally short; skip the word-count gate.
          const qualityText = articleExcerpt || contentText || summaryText || "";
          if (!isFacebookFeed && textWordCount(qualityText) < MIN_ARTICLE_WORDS) {
            await removeLowWordItem(env, feed.id, itemId);
            continue;
          }

          summary.itemsUpserted += 1;
          feedItemsUpserted += 1;

          const cachedSummary = await getCachedSummary(env, itemId);
          if (cachedSummary) {
            const cachedSeoDescription = await getCachedSeoDescription(env, itemId);
            await d1Run(env.ky_news_db, "UPDATE items SET summary=?, seo_description=COALESCE(?, seo_description) WHERE id=?", [
              cachedSummary,
              cachedSeoDescription,
              itemId
            ]);
          } else {
            const aiSummary = await generateSummaryWithAI(env, {
              itemId,
              title,
              url: link,
              articleText: articleExcerpt || `${title}\n${summaryText || ""}\n${contentText || ""}`
            });

            if (aiSummary) {
              summary.summariesGenerated += 1;
            }
          }

          const mirrorSource = articleImageCandidate || imageUrl;
          if (mirrorSource && /^https?:\/\//i.test(mirrorSource)) {
            const mirrored = await mirrorArticleImageToR2(env, {
              itemId,
              sourceUrl: mirrorSource
            });
            if (mirrored) summary.imagesMirrored += 1;
          }
        }
      } catch (err) {
        feedStatus = "error";
        feedErrorMessage = err instanceof Error ? err.message : String(err);
        summary.errors += 1;
        summary.feedErrors.push({
          feedId: feed.id,
          error: feedErrorMessage
        });
        await recordError(env, feed.id, err);
        logWarn("ingest.feed.failed", {
          feedId: feed.id,
          name: feed.name,
          error: feedErrorMessage
        });
      } finally {
        await d1Run(env.ky_news_db, "UPDATE feeds SET last_checked_at=datetime('now') WHERE id=?", [feed.id]);

        const feedMetric = {
          feedId: feed.id,
          status: feedStatus,
          httpStatus: feedHttpStatus,
          durationMs: Date.now() - feedStarted,
          itemsSeen: feedItemsSeen,
          itemsUpserted: feedItemsUpserted,
          errorMessage: feedErrorMessage
        };
        summary.feedMetrics.push(feedMetric);
        await recordFeedMetric(env, {
          runId: summary.runId,
          source: summary.source,
          ...feedMetric
        });
      }
    }

    summary.status = "ok";
    return summary;
  } catch (err) {
    summary.status = "failed";
    summary.errors += 1;
    logError("ingest.run.failed", err, { runId: summary.runId, source: options.source });
    throw err;
  } finally {
    summary.finishedAt = new Date().toISOString();
    await finishRun(env, summary.runId, summary.status, summary);
    await recordRunMetrics(env, summary);
    await writeStructuredLog(env, {
      level: summary.status === "ok" ? "info" : "error",
      event: "ingest.run.complete",
      ts: new Date().toISOString(),
      data: {
        runId: summary.runId,
        source: summary.source,
        status: summary.status,
        feedsProcessed: summary.feedsProcessed,
        itemsUpserted: summary.itemsUpserted,
        errors: summary.errors
      }
    });
    logInfo("ingest.run.complete", {
      runId: summary.runId,
      source: summary.source,
      status: summary.status,
      feedsProcessed: summary.feedsProcessed,
      itemsUpserted: summary.itemsUpserted,
      errors: summary.errors
    });
  }
}

export async function runManualIngest(env: Env): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }> {
  try {
    const result = await ingestFeeds(env, { source: "manual", force: true });
    return {
      ok: true,
      code: 0,
      stdout: JSON.stringify(result),
      stderr: ""
    };
  } catch (err) {
    return {
      ok: false,
      code: 1,
      stdout: "",
      stderr: err instanceof Error ? `${err.message}\n${err.stack || ""}` : String(err)
    };
  }
}

export async function runManualFeedIngest(
  env: Env,
  feedIds: string[]
): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }> {
  try {
    const result = await ingestFeeds(env, { source: "manual-feed", force: true, feedIds });
    return {
      ok: true,
      code: 0,
      stdout: JSON.stringify(result),
      stderr: ""
    };
  } catch (err) {
    return {
      ok: false,
      code: 1,
      stdout: "",
      stderr: err instanceof Error ? `${err.message}\n${err.stack || ""}` : String(err)
    };
  }
}

export async function runScheduledIngest(env: Env): Promise<void> {
  try {
    await ingestFeeds(env, { source: "cron" });
  } catch (err) {
    logError("ingest.cron.failed", err);
  }
}
