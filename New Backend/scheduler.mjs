#!/usr/bin/env node
/**
 * scheduler.mjs
 * =============
 * Node.js task scheduler that mirrors the Cloudflare Worker cron schedule
 * defined in New Backend/wrangler.toml.
 *
 * Uses native setInterval / setTimeout — no cron library required.
 *
 * Schedule (copied from wrangler.toml):
 *   */15 * * * *    Feed ingestion            (every 15 min)
 *   */5  * * * *    Body worker + AI          (every 5 min)
 *   0 */6 * * *     School calendar sync      (every 6 hours)
 *   0 8   * * *     Legislature bill scraper  (daily at 8 AM UTC)
 *   0 4   * * *     Coverage check + alerts   (daily at 4 AM UTC)
 *   0 3   * * 0     RSS discovery             (weekly, Sunday 3 AM UTC)
 *   0 6   * * *     Bing fallback feed sync   (daily at 6 AM UTC)
 *
 * Usage:
 *   node "New Backend/scheduler.mjs"
 *
 * Environment:
 *   DB_PATH   – path to SQLite file (defaults to data/dev.sqlite)
 *   LOG_LEVEL – 'silent' to suppress verbose output
 *
 * The scheduler opens a fresh DB connection for each task run, matching the
 * same pattern used by the HTTP server routes. Each task is wrapped in a
 * try/catch so one failure never stops the scheduler.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db-adapter.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..");
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.resolve(repoRoot, "data", "dev.sqlite");

const SILENT = process.env.LOG_LEVEL === "silent";

// ─── Simple logger ─────────────────────────────────────────────────────────

function log(tag, msg, extra = null) {
  if (SILENT) return;
  const ts = new Date().toISOString();
  const line = extra
    ? `[${ts}] [${tag}] ${msg} ${JSON.stringify(extra)}`
    : `[${ts}] [${tag}] ${msg}`;
  console.log(line);
}

function err(tag, msg, error) {
  const ts = new Date().toISOString();
  console.error(`[${ts}] [${tag}] ERROR: ${msg}`, error?.message || error);
}

// ─── DB helper ─────────────────────────────────────────────────────────────

async function withDb(fn) {
  const db = await openDb({ path: DB_PATH });
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

// ─── Log error to fetch_errors table ───────────────────────────────────────

async function recordError(label, error) {
  try {
    await withDb(async (db) => {
      db.prepare(
        "INSERT INTO fetch_errors (at, error) VALUES (datetime('now'), @err)"
      ).run({ err: `${label} — ${String(error?.message || error)}` });
    });
  } catch {
    // Ignore — table may not exist yet (run migrate-sqlite.mjs first)
  }
}

// ─── Task wrappers ──────────────────────────────────────────────────────────

async function taskFeedIngestion() {
  log("ingest", "Starting feed ingestion…");
  try {
    const { runIngestion } = await import("./ingestion-v3.mjs").catch(() => {
      // Fall back to body-worker-v2 if ingestion-v3 doesn't export runIngestion
      return {};
    });

    if (typeof runIngestion === "function") {
      await withDb(async (db) => {
        await runIngestion(db, { env: process.env });
      });
      log("ingest", "Feed ingestion complete");
    } else {
      // Spawn the old ingester as a child process (backward compat)
      const { spawn } = await import("node:child_process");
      const ingesterScript = path.resolve(repoRoot, "apps", "ingester", "src", "ingester.mjs");
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [ingesterScript, "--once"], {
          cwd: repoRoot,
          env: { ...process.env, INGEST_ONCE: "1" },
          stdio: "inherit"
        });
        const t = setTimeout(() => { child.kill("SIGTERM"); }, 180_000);
        child.on("close", (code) => { clearTimeout(t); resolve(code); });
        child.on("error", (e) => { clearTimeout(t); reject(e); });
      });
      log("ingest", "Feed ingestion (legacy runner) complete");
    }
  } catch (e) {
    err("ingest", "Feed ingestion failed", e);
    await recordError("scheduler:ingest", e);
  }
}

async function taskBodyWorker() {
  log("body", "Starting body worker…");
  try {
    const { runBodyWorker } = await import("./body-worker-v2.mjs");
    await withDb(async (db) => {
      await runBodyWorker(db, { env: process.env });
    });
    log("body", "Body worker complete");
  } catch (e) {
    err("body", "Body worker failed", e);
    await recordError("scheduler:body", e);
  }
}

async function taskSchoolCalendar() {
  log("schools", "Starting school calendar sync…");
  try {
    const { syncSchoolCalendars } = await import("./school-calendar.mjs");
    await withDb(async (db) => {
      await syncSchoolCalendars(db);
    });
    log("schools", "School calendar sync complete");
  } catch (e) {
    err("schools", "School calendar sync failed", e);
    await recordError("scheduler:schools", e);
  }
}

async function taskLegislature() {
  log("legislature", "Starting legislature bill scraper…");
  try {
    const { scrapeLegislatureBills, syncBillsToDb } = await import("./legislature.mjs");
    const bills = await scrapeLegislatureBills();
    if (bills.length > 0) {
      await withDb(async (db) => {
        await syncBillsToDb(db, bills);
      });
      log("legislature", `Legislature sync complete — ${bills.length} bills`);
    } else {
      log("legislature", "Legislature scraper returned 0 bills — skipping DB write");
    }
  } catch (e) {
    err("legislature", "Legislature scraper failed", e);
    await recordError("scheduler:legislature", e);
  }
}

async function taskCoverageAlerts() {
  log("coverage", "Starting coverage check + alerting…");
  try {
    const { alertCoverageGaps, alertFeedFailures } = await import("./alerting.mjs");
    await withDb(async (db) => {
      await alertCoverageGaps(db);
      await alertFeedFailures(db);
    });
    log("coverage", "Coverage + alerting complete");
  } catch (e) {
    err("coverage", "Coverage check failed", e);
    await recordError("scheduler:coverage", e);
  }
}

async function taskRssDiscovery() {
  log("rss-discovery", "Starting RSS auto-discovery…");
  try {
    const mod = await import("./bing-fallback-worker.mjs");
    const runRssDiscovery = mod.runRssDiscovery ?? mod.syncBingFallbackFeeds;
    if (typeof runRssDiscovery === "function") {
      await withDb(async (db) => {
        await runRssDiscovery(db);
      });
      log("rss-discovery", "RSS discovery complete");
    } else {
      log("rss-discovery", "No runRssDiscovery export found — skipping");
    }
  } catch (e) {
    err("rss-discovery", "RSS discovery failed", e);
    await recordError("scheduler:rss-discovery", e);
  }
}

async function taskBingFallback() {
  log("bing", "Starting Bing fallback feed sync…");
  try {
    const { syncBingFallbackFeeds } = await import("./bing-fallback-worker.mjs");
    await withDb(async (db) => {
      await syncBingFallbackFeeds(db);
    });
    log("bing", "Bing fallback sync complete");
  } catch (e) {
    err("bing", "Bing fallback sync failed", e);
    await recordError("scheduler:bing", e);
  }
}

// ─── Scheduling helpers ─────────────────────────────────────────────────────

/**
 * Run a task immediately (for testing / first-boot), then on a fixed interval.
 * @param {string}   name
 * @param {Function} fn
 * @param {number}   intervalMs
 * @param {boolean}  runImmediately
 */
function scheduleInterval(name, fn, intervalMs, runImmediately = false) {
  const run = async () => {
    log("scheduler", `▶ ${name}`);
    const t0 = Date.now();
    try {
      await fn();
    } catch (e) {
      err("scheduler", `Uncaught error in ${name}`, e);
    }
    log("scheduler", `■ ${name} (${Date.now() - t0}ms)`);
  };

  if (runImmediately) {
    // Stagger immediate runs by 2 s each so they don't all start at once
    setTimeout(run, 0);
  }

  setInterval(run, intervalMs);
  log("scheduler", `Registered "${name}" every ${intervalMs / 1000}s`);
}

/**
 * Schedule a task to run at a specific UTC hour each day.
 * Fires the task at the next occurrence of `targetHourUtc:00:00 UTC`,
 * then every 24 hours after that.
 */
function scheduleDailyUtc(name, fn, targetHourUtc) {
  const run = async () => {
    log("scheduler", `▶ ${name}`);
    const t0 = Date.now();
    try {
      await fn();
    } catch (e) {
      err("scheduler", `Uncaught error in ${name}`, e);
    }
    log("scheduler", `■ ${name} (${Date.now() - t0}ms)`);
  };

  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(targetHourUtc, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const delayMs = next - now;

  setTimeout(() => {
    run();
    setInterval(run, 24 * 60 * 60 * 1000);
  }, delayMs);

  log(
    "scheduler",
    `Registered "${name}" daily at ${String(targetHourUtc).padStart(2, "0")}:00 UTC ` +
      `(first run in ${Math.round(delayMs / 60000)} min)`
  );
}

/**
 * Schedule a task to run once per week at a specific UTC day + hour.
 * @param {number} targetDayUtc   0=Sun … 6=Sat
 * @param {number} targetHourUtc  0-23
 */
function scheduleWeeklyUtc(name, fn, targetDayUtc, targetHourUtc) {
  const run = async () => {
    log("scheduler", `▶ ${name}`);
    const t0 = Date.now();
    try {
      await fn();
    } catch (e) {
      err("scheduler", `Uncaught error in ${name}`, e);
    }
    log("scheduler", `■ ${name} (${Date.now() - t0}ms)`);
  };

  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(targetHourUtc, 0, 0, 0);
  const daysUntil = (targetDayUtc - now.getUTCDay() + 7) % 7;
  next.setUTCDate(next.getUTCDate() + (daysUntil === 0 && next <= now ? 7 : daysUntil));
  const delayMs = next - now;

  setTimeout(() => {
    run();
    setInterval(run, 7 * 24 * 60 * 60 * 1000);
  }, delayMs);

  log(
    "scheduler",
    `Registered "${name}" weekly day=${targetDayUtc} ${String(targetHourUtc).padStart(2, "0")}:00 UTC ` +
      `(first run in ${Math.round(delayMs / 60000)} min)`
  );
}

// ─── Register all tasks ─────────────────────────────────────────────────────

log("scheduler", `Starting KY News Scheduler`);
log("scheduler", `DB_PATH=${DB_PATH}`);

// ① Feed ingestion — every 15 min
scheduleInterval("feed-ingestion", taskFeedIngestion, 15 * 60 * 1000, true);

// ② Body worker — every 5 min
scheduleInterval("body-worker", taskBodyWorker, 5 * 60 * 1000, true);

// ③ School calendar — every 6 hours
scheduleInterval("school-calendar", taskSchoolCalendar, 6 * 60 * 60 * 1000);

// ④ Legislature scraper — daily at 8 AM UTC
scheduleDailyUtc("legislature", taskLegislature, 8);

// ⑤ Coverage check + alerts — daily at 4 AM UTC
scheduleDailyUtc("coverage-alerts", taskCoverageAlerts, 4);

// ⑥ RSS discovery — weekly Sunday at 3 AM UTC  (day=0)
scheduleWeeklyUtc("rss-discovery", taskRssDiscovery, 0, 3);

// ⑦ Bing fallback sync — daily at 6 AM UTC
scheduleDailyUtc("bing-fallback", taskBingFallback, 6);

log("scheduler", "All tasks registered. Scheduler is running...\n");

// ─── Graceful shutdown ──────────────────────────────────────────────────────

process.on("SIGTERM", () => {
  log("scheduler", "SIGTERM received — shutting down");
  process.exit(0);
});

process.on("SIGINT", () => {
  log("scheduler", "SIGINT received — shutting down");
  process.exit(0);
});
