/**
 * Cloudflare Worker Entry Point
 *
 * Handles all scheduled cron triggers and routes them to the correct worker.
 * Also exposes a /health endpoint for monitoring.
 *
 * Bindings available:
 *   env.DB          — D1 database (f1669001-2a51-4114-a84e-73cfa7f1c584)
 *   env.AI          — Workers AI
 *   env.FEED_CACHE  — KV for ETags
 *   env.MINHASH_CACHE — KV for recent MinHash sigs
 */

import { openDb } from "../lib/db-adapter.mjs";
import { alertCoverageGaps, alertFeedFailures } from "../lib/alerting.mjs";
import { syncBingFallbackFeeds } from "../workers/bing-fallback-worker.mjs";

// We import lazy to keep boot time low — only load what the cron needs.

export default {
  // ── Scheduled cron handler ──────────────────────────────────────────────────
  async scheduled(event, env, ctx) {
    const db = await openDb({ d1: env.DB });

    // Pass AI binding through env for summarizer
    process.env.CF_SUMMARY_MODEL = env.CF_SUMMARY_MODEL || "@cf/zai-org/glm-4.7-flash";

    const cron = event.cron;
    console.log(`[cron] ${cron} fired`);

    try {
      if (cron === "*/15 * * * *") {
        // Feed ingestion
        const { runIngestion } = await import("../workers/ingestion-worker.mjs");
        await runIngestion(db, env);

      } else if (cron === "*/5 * * * *") {
        // Body fetch + AI summarization
        const { runBodyWorker } = await import("../workers/body-worker-v2.mjs");
        await runBodyWorker(db, env);

      } else if (cron === "0 */6 * * *") {
        // School calendar sync
        const { syncSchoolCalendars } = await import("../lib/school-calendar.mjs");
        await syncSchoolCalendars(db);

      } else if (cron === "0 8 * * *") {
        // Legislature bill scraper
        const { scrapeLegislatureBills, syncBillsToDb } = await import("../lib/legislature.mjs");
        const bills = await scrapeLegislatureBills();
        if (bills.length > 0) await syncBillsToDb(db, bills);

      } else if (cron === "0 4 * * *") {
        // Coverage gap check + feed failure alerting
        await alertCoverageGaps(db);
        await alertFeedFailures(db);

      } else if (cron === "0 3 * * 0") {
        // RSS auto-discovery
        const { runRssDiscovery } = await import("../workers/rss-discovery-worker.mjs");
        await runRssDiscovery(db);

      } else if (cron === "0 6 * * *") {
        // Bing fallback feeds
        await syncBingFallbackFeeds(db);
      }

    } catch (err) {
      console.error(`[cron:${cron}] Error:`, err.message);
      // Record in fetch_errors
      try {
        await db.prepare(`INSERT INTO fetch_errors (at, error) VALUES (datetime('now'), @err)`)
          .run({ err: `cron:${cron} — ${err.message}` });
      } catch {}
    }
  },

  // ── HTTP handler (health check + admin) ────────────────────────────────────
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        db: "d1:f1669001-2a51-4114-a84e-73cfa7f1c584",
        timestamp: new Date().toISOString(),
      });
    }

    if (url.pathname === "/admin/coverage" && request.method === "GET") {
      const db = await openDb({ d1: env.DB });
      const { KY_COUNTIES } = await import("../lib/ky-geo.mjs");
      const covered = await db.prepare(`
        SELECT il.county, COUNT(DISTINCT i.id) as n, MAX(i.published_at) as latest
        FROM item_locations il
        JOIN items i ON i.id = il.item_id
        WHERE il.state_code = 'KY' AND il.county != ''
          AND i.published_at >= datetime('now', '-7 days')
        GROUP BY il.county
      `).all();

      const coveredMap = new Map(covered.map((r) => [r.county, r]));
      const report = KY_COUNTIES.map((c) => ({
        county: c,
        articles: coveredMap.get(c)?.n || 0,
        latest: coveredMap.get(c)?.latest || null,
      })).sort((a, b) => a.articles - b.articles);

      return Response.json(report, {
        headers: { "Cache-Control": "public, max-age=300" },
      });
    }

    return new Response("KY News Ingestion Worker", { status: 200 });
  },
};
