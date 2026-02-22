import { randomUUID } from "node:crypto";
import { d1All, d1First, d1Run } from "../services/db";
import { parseFeedItems } from "../services/rss";
import { scrapeFeedItems } from "../services/scrapers";
import { detectKyCounties, detectOtherStateNames, hasKySignal } from "../services/location";
import { fetchArticle } from "../services/article";
import { getCachedSummary, generateSummaryWithAI } from "../services/summary";
import { mirrorArticleImageToR2 } from "../services/media";
import { makeItemId, stableHash } from "../lib/crypto";
import { normalizeCounty } from "../lib/utils";
import { decodeHtmlEntities, toHttpsUrl } from "../lib/text";
import { logError, logInfo, logWarn } from "../lib/logger";
import type { Env } from "../types";
import { incrementMetricGroup, writeStructuredLog } from "../services/observability";

const FEED_TIMEOUT_MS = 15_000;

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

async function tagItemLocations(
  env: Env,
  input: {
    itemId: string;
    stateCode: string;
    parts: string[];
    url: string;
    author?: string | null;
    defaultCounty?: string | null;
    feedUrl?: string | null;
  }
): Promise<{ excerpt: string; imageCandidate: string | null; publishedAt: string | null }> {
  const st = (input.stateCode || "KY").toUpperCase();

  await d1Run(env.ky_news_db, "DELETE FROM item_locations WHERE item_id=? AND state_code=?", [input.itemId, st]);

  const titleText = String(input.parts[0] || "");
  const baseText = input.parts.filter(Boolean).join(" \n");
  const titleCounties = detectKyCounties(titleText);
  const baseCounties = detectKyCounties(baseText);
  const titleKySignal = st !== "KY" ? true : hasKySignal(titleText, titleCounties);
  const baseKySignal = st !== "KY" ? true : hasKySignal(baseText, baseCounties);
  const baseOtherStateNames = st === "KY" ? detectOtherStateNames(baseText) : [];
  const titleOtherStateNames = st === "KY" ? detectOtherStateNames(titleText) : [];

  let counties = [...baseCounties];
  let excerptCounties: string[] = [];
  let otherStateNames = [...baseOtherStateNames];

  let urlSectionLooksOutOfState = false;
  if (st === "KY") {
    try {
      const path = new URL(input.url).pathname.toLowerCase();
      urlSectionLooksOutOfState = /\/(national|world|region)\//.test(path);
    } catch {
      urlSectionLooksOutOfState = false;
    }
  }

  const looksSyndicated =
    /\/ap\//i.test(input.url) ||
    /\bassociated press\b/i.test(baseText) ||
    /^ap\b/i.test(String(input.author || "").trim().toLowerCase());

  const meta = await d1First<{
    article_checked_at: string | null;
    article_fetch_status: string | null;
    article_text_excerpt: string | null;
    image_url: string | null;
    published_at: string | null;
  }>(
    env.ky_news_db,
    "SELECT article_checked_at, article_fetch_status, article_text_excerpt, image_url, published_at FROM items WHERE id=?",
    [input.itemId]
  );

  const alreadyChecked = Boolean(meta?.article_checked_at);
  const needsImage = !String(meta?.image_url || "").trim() || /^https?:\/\//i.test(String(meta?.image_url || ""));
  const needsPublishedDate = !String(meta?.published_at || "").trim();
  let excerpt = textOnly(meta?.article_text_excerpt || "");
  let imageCandidate: string | null = null;
  let publishedAt: string | null = null;

  if ((!counties.length || needsImage || excerpt.length < 300 || needsPublishedDate) && !alreadyChecked) {
    const fetched = await fetchArticle(input.url);
    excerpt = fetched.text || "";
    imageCandidate = fetched.ogImage || null;
    publishedAt = fetched.publishedAt || null;
    excerptCounties = detectKyCounties(excerpt);
    counties = Array.from(new Set([...baseCounties, ...excerptCounties]));

    if (st === "KY") {
      otherStateNames = Array.from(new Set([...otherStateNames, ...detectOtherStateNames(excerpt)]));
    }

    await d1Run(
      env.ky_news_db,
      `
      UPDATE items
      SET
        article_checked_at = datetime('now'),
        article_fetch_status = ?,
        article_text_excerpt = ?,
        published_at = COALESCE(published_at, ?),
        content = COALESCE(content, ?),
        image_url = COALESCE(image_url, ?)
      WHERE id=?
      `,
      [fetched.status, excerpt || null, fetched.publishedAt || null, excerpt || null, fetched.ogImage || null, input.itemId]
    );
  }

  const isKyGoogleWatchFeed =
    /news\.google\.com\/rss\/search/i.test(String(input.feedUrl || "")) &&
    /kentucky/i.test(decodeURIComponent(String(input.feedUrl || "")));

  const hasTitleOutOfStateSignal =
    st === "KY" &&
    titleOtherStateNames.length > 0 &&
    !titleKySignal &&
    titleCounties.length === 0;
  const hasPrimaryOutOfStateSignal =
    st === "KY" &&
    baseOtherStateNames.length > 0 &&
    !baseKySignal &&
    baseCounties.length === 0;
  if (st === "KY" && (hasTitleOutOfStateSignal || hasPrimaryOutOfStateSignal || (urlSectionLooksOutOfState && !baseKySignal)) && counties.length === 0) {
    return { excerpt, imageCandidate, publishedAt };
  }

  const kySignal =
    st !== "KY" ||
    isKyGoogleWatchFeed ||
    titleKySignal ||
    baseKySignal ||
    counties.length > 0;
  const hasOtherStateSignal = st === "KY" && otherStateNames.length > 0;
  if (st === "KY" && looksSyndicated && !kySignal && counties.length === 0) {
    return { excerpt, imageCandidate, publishedAt };
  }

  const shouldTagAsKy = st !== "KY" || kySignal || (!hasOtherStateSignal && !looksSyndicated && !urlSectionLooksOutOfState);

  if (!shouldTagAsKy) {
    return { excerpt, imageCandidate, publishedAt };
  }

  await d1Run(env.ky_news_db, "INSERT OR IGNORE INTO item_locations (item_id, state_code, county) VALUES (?, ?, '')", [
    input.itemId,
    st
  ]);

  if (st === "KY") {
    const tagged = new Set(counties.map((c) => normalizeCounty(c)).filter(Boolean));
    const fallbackCounty = normalizeCounty(input.defaultCounty || "");
    if (fallbackCounty && (kySignal || (!hasOtherStateSignal && !looksSyndicated || tagged.size > 0))) {
      tagged.add(fallbackCounty);
    }

    for (const county of tagged) {
      await d1Run(
        env.ky_news_db,
        "INSERT OR IGNORE INTO item_locations (item_id, state_code, county) VALUES (?, ?, ?)",
        [input.itemId, st, county]
      );
    }
  }

  return { excerpt, imageCandidate, publishedAt };
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

        if (fetchMode === "scrape") {
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

          if (upserted === "unchanged") {
            continue;
          }

          summary.itemsUpserted += 1;
          feedItemsUpserted += 1;

          let articleExcerpt = contentText || "";
          let articleImageCandidate = imageUrl;
          let articlePublishedAt = publishedAt;

          if ((feed.region_scope || "ky") === "ky") {
            const loc = await tagItemLocations(env, {
              itemId,
              stateCode: feed.state_code || "KY",
              parts: [title, summaryText || "", contentText || ""],
              url: link,
              author,
              defaultCounty: feed.default_county,
              feedUrl: feed.url
            });

            if (loc.excerpt && loc.excerpt.length > articleExcerpt.length) {
              articleExcerpt = loc.excerpt;
            }
            if (loc.imageCandidate) {
              articleImageCandidate = loc.imageCandidate;
            }
            if (!articlePublishedAt && loc.publishedAt) {
              articlePublishedAt = loc.publishedAt;
              await d1Run(env.ky_news_db, "UPDATE items SET published_at=COALESCE(published_at, ?) WHERE id=?", [
                loc.publishedAt,
                itemId
              ]);
            }
          }

          const cachedSummary = await getCachedSummary(env, itemId);
          if (cachedSummary) {
            await d1Run(env.ky_news_db, "UPDATE items SET summary=? WHERE id=?", [cachedSummary, itemId]);
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
