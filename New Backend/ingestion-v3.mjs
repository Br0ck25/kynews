/**
 * Migration: ingestion-v3
 * Adds tables and columns for:
 *  - D1 compatibility (no breaking changes — same schema works on D1)
 *  - Duplicate detection (minhash, is_duplicate, canonical_id)
 *  - Paywall detection (is_paywalled, paywall_confidence, paywall_deprioritized)
 *  - Breaking news (is_breaking, alert_level, sentiment, breaking_expires_at)
 *  - Bing fallback feeds (is_bing_fallback column on feeds)
 *  - KY Bills + article_bills junction
 *  - School events calendar
 *  - Alert log (deduplication for alerting module)
 *
 * Run: node migrations/ingestion-v3.mjs
 *
 * D1: wrangler d1 execute ky-news --file migrations/ingestion-v3.sql
 */

const SQL = `
-- ─── Items: dedup columns ─────────────────────────────────────────────────────
ALTER TABLE items ADD COLUMN minhash TEXT;
-- 16 x 8-char hex = 128 char MinHash signature
ALTER TABLE items ADD COLUMN is_duplicate INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN canonical_item_id TEXT;
-- If is_duplicate=1, canonical_item_id points to the "original" item

-- ─── Items: paywall columns ───────────────────────────────────────────────────
ALTER TABLE items ADD COLUMN is_paywalled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN paywall_confidence INTEGER NOT NULL DEFAULT 0;
-- 0-100 confidence score
ALTER TABLE items ADD COLUMN paywall_signals TEXT;
-- JSON array of detected signals
ALTER TABLE items ADD COLUMN paywall_deprioritized INTEGER NOT NULL DEFAULT 0;
-- 1 = free duplicate exists; sink to bottom of feed

-- ─── Items: breaking news columns ────────────────────────────────────────────
ALTER TABLE items ADD COLUMN is_breaking INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN alert_level TEXT;
-- 'breaking' | 'emergency' | 'developing' | NULL
ALTER TABLE items ADD COLUMN sentiment TEXT;
-- 'positive' | 'negative' | 'neutral'
ALTER TABLE items ADD COLUMN breaking_expires_at TEXT;
-- ISO timestamp; breaking status expires after 4h

-- ─── Feeds: Bing fallback flag ────────────────────────────────────────────────
ALTER TABLE feeds ADD COLUMN is_bing_fallback INTEGER NOT NULL DEFAULT 0;
-- 1 = auto-generated Bing RSS fallback (lower priority)

-- ─── KY Bills ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ky_bills (
  bill_number   TEXT PRIMARY KEY,  -- e.g. "HB 1", "SB 200"
  bill_type     TEXT NOT NULL,     -- "HB", "SB", "HCR" etc.
  bill_num      INTEGER NOT NULL,
  title         TEXT NOT NULL,
  status        TEXT,
  url           TEXT,
  session_year  INTEGER NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ky_bills_session ON ky_bills(session_year);
CREATE INDEX IF NOT EXISTS idx_ky_bills_type ON ky_bills(bill_type, bill_num);

-- ─── Article <-> Bills junction ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS article_bills (
  item_id     TEXT NOT NULL,
  bill_number TEXT NOT NULL,
  PRIMARY KEY (item_id, bill_number),
  FOREIGN KEY (item_id)     REFERENCES items(id) ON DELETE CASCADE,
  FOREIGN KEY (bill_number) REFERENCES ky_bills(bill_number) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_article_bills_bill ON article_bills(bill_number);
CREATE INDEX IF NOT EXISTS idx_article_bills_item ON article_bills(item_id);

-- ─── School Events ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS school_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  uid         TEXT NOT NULL UNIQUE,     -- ICS UID or generated key
  county      TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT,
  start_at    TEXT NOT NULL,            -- ISO datetime
  end_at      TEXT,
  location    TEXT,
  url         TEXT,
  fetched_at  TEXT NOT NULL DEFAULT (datetime('now')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_school_events_county    ON school_events(county, start_at);
CREATE INDEX IF NOT EXISTS idx_school_events_start     ON school_events(start_at);

-- ─── Alert Log ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_key TEXT NOT NULL,
  fired_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_alert_log_key_time ON alert_log(alert_key, fired_at);

-- ─── Composite indexes for new query patterns ─────────────────────────────────

-- Breaking news feed: KY articles, breaking, not expired
CREATE INDEX IF NOT EXISTS idx_items_breaking ON items(is_breaking, breaking_expires_at, published_at);

-- Non-paywalled first ordering
CREATE INDEX IF NOT EXISTS idx_items_paywall ON items(is_paywalled, paywall_deprioritized, published_at);

-- Dedup: find recent items with minhash for comparison
CREATE INDEX IF NOT EXISTS idx_items_minhash_fetched ON items(minhash, fetched_at) WHERE minhash IS NOT NULL;

-- Bing fallback: lower priority items
CREATE INDEX IF NOT EXISTS idx_feeds_bing ON feeds(is_bing_fallback, enabled);
`;

// ─── Apply migration ──────────────────────────────────────────────────────────

import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dbPath = process.env.DB_PATH || path.join(root, "data", "dev.sqlite");

// For local SQLite
const { default: Database } = await import("better-sqlite3");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// SQLite doesn't support IF NOT EXISTS on ALTER TABLE, so wrap each in try/catch
const statements = SQL.split(";").map((s) => s.trim()).filter(Boolean);

for (const stmt of statements) {
  try {
    db.exec(stmt + ";");
  } catch (err) {
    if (err.message.includes("duplicate column name") || err.message.includes("already exists")) {
      // Idempotent — skip already-applied changes
      continue;
    }
    console.error(`Failed: ${stmt.slice(0, 80)}\n  → ${err.message}`);
  }
}

db.close();
console.log("✅ Migration ingestion-v3 applied:", dbPath);

// ─── Export SQL for D1 ────────────────────────────────────────────────────────
// Run with: wrangler d1 execute ky-news --file migrations/ingestion-v3.sql
import { writeFileSync } from "node:fs";
writeFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "ingestion-v3.sql"),
  SQL.trim()
);
console.log("✅ SQL exported to migrations/ingestion-v3.sql (for D1)");
