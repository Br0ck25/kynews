/**
 * Bing News RSS Fallback
 *
 * For Kentucky counties with zero dedicated news sources,
 * auto-generates Bing News RSS feeds scoped to that county.
 *
 * These are used as a fallback only — real local sources are always preferred.
 * Bing feeds are deprioritized in the UI (shown with a "via Bing" label).
 *
 * Also generates feeds for each KY news source in the master database
 * using site: operator to get fresh article lists.
 *
 * Run: node workers/bing-fallback-worker.mjs
 * Or call syncBingFallbackFeeds(db) from the seed script.
 */

import { KY_COUNTIES } from "../lib/ky-geo.mjs";

// Counties that have dedicated local sources (skip Bing fallback for these)
// This list should be updated as you add real sources.
const WELL_COVERED_COUNTIES = new Set([
  "Fayette", "Jefferson", "Warren", "Daviess", "McCracken",
  "Kenton", "Campbell", "Boone", "Madison", "Hardin",
  "Christian", "Henderson", "Boyd", "Pulaski", "Laurel",
  "Floyd", "Pike", "Perry", "Harlan", "Letcher",
  "Knox", "Bell", "Whitley", "Rowan", "Johnson",
  "Carter", "Greenup", "Lawrence", "Martin", "Magoffin",
  "Montgomery", "Clark", "Scott", "Franklin", "Jessamine",
  "Woodford", "Bourbon", "Bath", "Fleming", "Nicholas",
]);

/**
 * Build a Bing News RSS URL for a Kentucky county.
 */
export function buildBingCountyFeedUrl(county) {
  const query = `${county} County Kentucky`;
  return `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`;
}

/**
 * Build a Bing News RSS URL for a specific news source domain.
 */
export function buildBingSiteFeedUrl(domain) {
  const query = `site:${domain} Kentucky`;
  return `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`;
}

/**
 * Generate Bing fallback feed rows for uncovered counties.
 * Returns array of feed objects ready to upsert into feeds table.
 */
export function generateBingCountyFeeds(coveredCounties = new Set()) {
  const feeds = [];

  for (const county of KY_COUNTIES) {
    // Skip if we already have real coverage
    if (WELL_COVERED_COUNTIES.has(county)) continue;
    if (coveredCounties.has(county)) continue;

    feeds.push({
      id: `bing-county-${county.toLowerCase().replace(/\s+/g, "-")}`,
      name: `${county} County News (Bing)`,
      category: "Bing Fallback",
      url: buildBingCountyFeedUrl(county),
      state_code: "KY",
      default_county: county,
      region_scope: "ky",
      fetch_mode: "rss",
      scraper_id: null,
      enabled: 1,
      is_bing_fallback: 1,
    });
  }

  return feeds;
}

/**
 * Sync Bing fallback feeds to DB.
 * Only adds feeds for counties that currently have zero dedicated feeds.
 */
export async function syncBingFallbackFeeds(db) {
  // Find counties that already have at least one dedicated (non-Bing) feed
  const coveredRaw = await db.prepare(`
    SELECT DISTINCT default_county as county
    FROM feeds
    WHERE enabled = 1
      AND default_county IS NOT NULL
      AND (is_bing_fallback IS NULL OR is_bing_fallback = 0)
  `).all();

  const coveredCounties = new Set(coveredRaw.map((r) => r.county).filter(Boolean));

  const bingFeeds = generateBingCountyFeeds(coveredCounties);

  console.log(`📡 Adding ${bingFeeds.length} Bing fallback feeds for uncovered counties`);

  for (const feed of bingFeeds) {
    await db.prepare(`
      INSERT INTO feeds (id, name, category, url, state_code, default_county, region_scope, fetch_mode, scraper_id, enabled, is_bing_fallback)
      VALUES (@id, @name, @category, @url, @state_code, @default_county, @region_scope, @fetch_mode, @scraper_id, @enabled, 1)
      ON CONFLICT(id) DO UPDATE SET
        url     = excluded.url,
        enabled = excluded.enabled
    `).run({
      ...feed,
      state_code: feed.state_code || "KY",
      region_scope: feed.region_scope || "ky",
      fetch_mode: feed.fetch_mode || "rss",
      scraper_id: feed.scraper_id || null,
    });
  }

  console.log(`✅ Bing fallback feeds synced`);
  return bingFeeds.length;
}

/**
 * Standalone script entrypoint.
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { openDb } = await import("../lib/db-adapter.mjs");

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const db = await openDb({ path: process.env.DB_PATH || `${root}/data/dev.sqlite` });

  await syncBingFallbackFeeds(db);
  if (db.close) db.close();
}
