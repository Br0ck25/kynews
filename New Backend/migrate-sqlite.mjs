#!/usr/bin/env node
/**
 * migrate-sqlite.mjs
 * ==================
 * Idempotent migration script that safely adds all new columns and tables
 * introduced by the New Backend (ingestion-v3) to the existing SQLite database.
 *
 * SAFETY GUARANTEES:
 *  - Never drops tables or columns
 *  - Never deletes data
 *  - Skips statements that would add duplicate columns/tables (idempotent)
 *  - Works against the live data/dev.sqlite without downtime
 *
 * Usage:
 *   node "New Backend/migrate-sqlite.mjs"
 *   DB_PATH=/path/to/custom.sqlite node "New Backend/migrate-sqlite.mjs"
 *
 * Run this ONCE before starting the new server.mjs for the first time.
 * Running it again is always safe — already-applied changes are skipped.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..");
const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.resolve(repoRoot, "data", "dev.sqlite");

console.log(`\n🔧  migrate-sqlite.mjs`);
console.log(`   DB: ${dbPath}\n`);

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function columnExists(table, column) {
  try {
    const rows = db.prepare(`PRAGMA table_info("${table}")`).all();
    return rows.some((r) => r.name === column);
  } catch {
    return false;
  }
}

function tableExists(table) {
  try {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(table);
    return Boolean(row);
  } catch {
    return false;
  }
}

function indexExists(indexName) {
  try {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
      .get(indexName);
    return Boolean(row);
  } catch {
    return false;
  }
}

let applied = 0;
let skipped = 0;

function addColumn(table, column, definition) {
  if (columnExists(table, column)) {
    console.log(`  ⏭  SKIP  ALTER TABLE ${table} ADD COLUMN ${column} (already exists)`);
    skipped++;
    return;
  }
  try {
    db.prepare(`ALTER TABLE "${table}" ADD COLUMN ${column} ${definition}`).run();
    console.log(`  ✅  ADD   ALTER TABLE ${table} ADD COLUMN ${column}`);
    applied++;
  } catch (err) {
    if (
      err.message.includes("duplicate column name") ||
      err.message.includes("already exists")
    ) {
      console.log(`  ⏭  SKIP  ALTER TABLE ${table} ADD COLUMN ${column} (race, already exists)`);
      skipped++;
    } else {
      console.error(`  ❌  FAIL  ALTER TABLE ${table} ADD COLUMN ${column}: ${err.message}`);
      throw err;
    }
  }
}

function execIfNotExists(label, sql) {
  // Extract table name from "CREATE TABLE IF NOT EXISTS <name>" for pre-check.
  const tableMatch = sql.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"?(\w+)"?/i);
  if (tableMatch && tableExists(tableMatch[1])) {
    console.log(`  ⏭  SKIP  ${label} (already exists)`);
    skipped++;
    return;
  }
  try {
    db.exec(sql);
    console.log(`  ✅  EXEC  ${label}`);
    applied++;
  } catch (err) {
    if (err.message.includes("already exists")) {
      console.log(`  ⏭  SKIP  ${label} (already exists)`);
      skipped++;
    } else {
      console.error(`  ❌  FAIL  ${label}: ${err.message}`);
      throw err;
    }
  }
}

function createIndex(indexName, sql) {
  if (indexExists(indexName)) {
    console.log(`  ⏭  SKIP  INDEX ${indexName} (already exists)`);
    skipped++;
    return;
  }
  try {
    db.exec(sql);
    console.log(`  ✅  IDX   ${indexName}`);
    applied++;
  } catch (err) {
    if (err.message.includes("already exists")) {
      console.log(`  ⏭  SKIP  INDEX ${indexName} (race, already exists)`);
      skipped++;
    } else {
      console.error(`  ❌  FAIL  INDEX ${indexName}: ${err.message}`);
      // Non-fatal for indexes
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Items: dedup columns (from ingestion-v3)
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n[1/9] Items — dedup columns");
addColumn("items", "minhash",           "TEXT");
addColumn("items", "is_duplicate",      "INTEGER NOT NULL DEFAULT 0");
addColumn("items", "canonical_item_id", "TEXT");

// ─────────────────────────────────────────────────────────────────────────────
// 2. Items: paywall columns (from ingestion-v3)
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n[2/9] Items — paywall columns");
addColumn("items", "is_paywalled",          "INTEGER NOT NULL DEFAULT 0");
addColumn("items", "paywall_confidence",    "INTEGER NOT NULL DEFAULT 0");
addColumn("items", "paywall_signals",       "TEXT");
addColumn("items", "paywall_deprioritized", "INTEGER NOT NULL DEFAULT 0");

// ─────────────────────────────────────────────────────────────────────────────
// 3. Items: breaking news columns (from ingestion-v3)
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n[3/9] Items — breaking news columns");
addColumn("items", "is_breaking",        "INTEGER NOT NULL DEFAULT 0");
addColumn("items", "alert_level",        "TEXT");
addColumn("items", "sentiment",          "TEXT");
addColumn("items", "breaking_expires_at","TEXT");

// ─────────────────────────────────────────────────────────────────────────────
// 4. Items: SEO / AI columns
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n[4/9] Items — SEO / AI columns");
addColumn("items", "ai_meta_description", "TEXT");
addColumn("items", "word_count",          "INTEGER");
addColumn("items", "categories_json",     "TEXT");
addColumn("items", "is_facebook",         "INTEGER NOT NULL DEFAULT 0");

// ─────────────────────────────────────────────────────────────────────────────
// 5. Feeds: Bing fallback flag (from ingestion-v3)
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n[5/9] Feeds — Bing fallback column");
addColumn("feeds", "is_bing_fallback", "INTEGER NOT NULL DEFAULT 0");

// ─────────────────────────────────────────────────────────────────────────────
// 6. New tables (from ingestion-v3 + queries.mjs)
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n[6/9] New tables");

execIfNotExists("CREATE TABLE ky_bills", `
  CREATE TABLE IF NOT EXISTS ky_bills (
    bill_number  TEXT PRIMARY KEY,
    bill_type    TEXT NOT NULL,
    bill_num     INTEGER NOT NULL,
    title        TEXT NOT NULL,
    status       TEXT,
    url          TEXT,
    session_year INTEGER NOT NULL,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

execIfNotExists("CREATE TABLE article_bills", `
  CREATE TABLE IF NOT EXISTS article_bills (
    item_id     TEXT NOT NULL,
    bill_number TEXT NOT NULL,
    PRIMARY KEY (item_id, bill_number),
    FOREIGN KEY (item_id)     REFERENCES items(id)     ON DELETE CASCADE,
    FOREIGN KEY (bill_number) REFERENCES ky_bills(bill_number) ON DELETE CASCADE
  )
`);

execIfNotExists("CREATE TABLE school_events", `
  CREATE TABLE IF NOT EXISTS school_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    uid         TEXT NOT NULL UNIQUE,
    county      TEXT NOT NULL,
    title       TEXT NOT NULL,
    description TEXT,
    start_at    TEXT NOT NULL,
    end_at      TEXT,
    location    TEXT,
    url         TEXT,
    fetched_at  TEXT NOT NULL DEFAULT (datetime('now')),
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

execIfNotExists("CREATE TABLE alert_log", `
  CREATE TABLE IF NOT EXISTS alert_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_key TEXT NOT NULL,
    fired_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// item_categories — used by queries.mjs category-based queries
execIfNotExists("CREATE TABLE item_categories", `
  CREATE TABLE IF NOT EXISTS item_categories (
    item_id  TEXT NOT NULL,
    category TEXT NOT NULL,
    PRIMARY KEY (item_id, category),
    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
  )
`);

// ingestion_queue — used by queries.mjs to exclude rejected-short articles
execIfNotExists("CREATE TABLE ingestion_queue", `
  CREATE TABLE IF NOT EXISTS ingestion_queue (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id    TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// fetch_errors — used by the CF Worker cron to log errors
execIfNotExists("CREATE TABLE fetch_errors", `
  CREATE TABLE IF NOT EXISTS fetch_errors (
    id  INTEGER PRIMARY KEY AUTOINCREMENT,
    at  TEXT NOT NULL DEFAULT (datetime('now')),
    error TEXT NOT NULL
  )
`);

// ─────────────────────────────────────────────────────────────────────────────
// 7. Indexes for new columns & tables
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n[7/9] Indexes");

// Breaking news
createIndex(
  "idx_items_breaking",
  `CREATE INDEX IF NOT EXISTS idx_items_breaking
   ON items(is_breaking, breaking_expires_at, published_at)`
);

// Paywall ordering
createIndex(
  "idx_items_paywall",
  `CREATE INDEX IF NOT EXISTS idx_items_paywall
   ON items(is_paywalled, paywall_deprioritized, published_at)`
);

// MinHash dedup lookup
createIndex(
  "idx_items_minhash_fetched",
  `CREATE INDEX IF NOT EXISTS idx_items_minhash_fetched
   ON items(minhash, fetched_at) WHERE minhash IS NOT NULL`
);

// Bing fallback feeds
createIndex(
  "idx_feeds_bing",
  `CREATE INDEX IF NOT EXISTS idx_feeds_bing
   ON feeds(is_bing_fallback, enabled)`
);

// ky_bills
createIndex(
  "idx_ky_bills_session",
  `CREATE INDEX IF NOT EXISTS idx_ky_bills_session ON ky_bills(session_year)`
);
createIndex(
  "idx_ky_bills_type",
  `CREATE INDEX IF NOT EXISTS idx_ky_bills_type ON ky_bills(bill_type, bill_num)`
);

// article_bills
createIndex(
  "idx_article_bills_bill",
  `CREATE INDEX IF NOT EXISTS idx_article_bills_bill ON article_bills(bill_number)`
);
createIndex(
  "idx_article_bills_item",
  `CREATE INDEX IF NOT EXISTS idx_article_bills_item ON article_bills(item_id)`
);

// school_events
createIndex(
  "idx_school_events_county",
  `CREATE INDEX IF NOT EXISTS idx_school_events_county
   ON school_events(county, start_at)`
);
createIndex(
  "idx_school_events_start",
  `CREATE INDEX IF NOT EXISTS idx_school_events_start ON school_events(start_at)`
);

// alert_log
createIndex(
  "idx_alert_log_key_time",
  `CREATE INDEX IF NOT EXISTS idx_alert_log_key_time ON alert_log(alert_key, fired_at)`
);

// item_categories
createIndex(
  "idx_item_categories_category",
  `CREATE INDEX IF NOT EXISTS idx_item_categories_category ON item_categories(category)`
);
createIndex(
  "idx_item_categories_item",
  `CREATE INDEX IF NOT EXISTS idx_item_categories_item ON item_categories(item_id)`
);

// ingestion_queue
createIndex(
  "idx_ingestion_queue_item",
  `CREATE INDEX IF NOT EXISTS idx_ingestion_queue_item ON ingestion_queue(item_id, status)`
);

// fetch_errors
createIndex(
  "idx_fetch_errors_at",
  `CREATE INDEX IF NOT EXISTS idx_fetch_errors_at ON fetch_errors(at)`
);

// ─────────────────────────────────────────────────────────────────────────────
// 8. Existing schema columns (from apps/api/src/schema.mjs) — ensure present
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n[8/9] Legacy schema columns (schema.mjs compatibility)");

addColumn("feeds", "region_scope",   "TEXT NOT NULL DEFAULT 'ky'");
addColumn("feeds", "default_county", "TEXT");
addColumn("feeds", "fetch_mode",     "TEXT NOT NULL DEFAULT 'rss'");
addColumn("feeds", "scraper_id",     "TEXT");

addColumn("items", "region_scope",          "TEXT NOT NULL DEFAULT 'ky'");
addColumn("items", "fetched_at",            "TEXT");
addColumn("items", "article_fetch_status",  "TEXT");
addColumn("items", "article_text_excerpt",  "TEXT");
addColumn("items", "ai_summary",            "TEXT");
addColumn("items", "tags",                  "TEXT NOT NULL DEFAULT ''");

addColumn("lost_found_posts", "is_resolved",    "INTEGER NOT NULL DEFAULT 0");
addColumn("lost_found_posts", "resolved_at",    "TEXT");
addColumn("lost_found_posts", "resolved_note",  "TEXT");

// ─────────────────────────────────────────────────────────────────────────────
// 9. Backfill defaults for nullable date columns
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n[9/9] Backfill NULL defaults");

try {
  const r1 = db.prepare(
    "UPDATE items SET fetched_at=datetime('now') WHERE fetched_at IS NULL OR trim(fetched_at)=''"
  ).run();
  console.log(`  ✅  SET items.fetched_at for ${r1.changes} rows`);
} catch (e) {
  console.warn(`  ⚠️   Could not backfill items.fetched_at: ${e.message}`);
}

try {
  const r2 = db.prepare(
    "UPDATE feeds SET fetch_mode='rss' WHERE fetch_mode IS NULL OR trim(fetch_mode)=''"
  ).run();
  console.log(`  ✅  SET feeds.fetch_mode for ${r2.changes} rows`);
} catch (e) {
  console.warn(`  ⚠️   Could not backfill feeds.fetch_mode: ${e.message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Done
// ─────────────────────────────────────────────────────────────────────────────

db.close();

console.log(`\n✅  Migration complete.`);
console.log(`   Applied : ${applied}`);
console.log(`   Skipped : ${skipped}`);
console.log(`   DB      : ${dbPath}\n`);
