import { d1ExecMany, d1Run, tableHasColumn } from "./db";
import { logError } from "../lib/logger";
import type { Env } from "../types";

let schemaReady: Promise<void> | null = null;

async function addColumnIfMissing(db: D1Database, table: string, column: string, sqlType: string): Promise<void> {
  const has = await tableHasColumn(db, table, column);
  if (has) return;
  await d1Run(db, `ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType}`);
}

async function createCoreSchema(env: Env): Promise<void> {
  const db = env.ky_news_db;

  await d1ExecMany(db, [
    {
      sql: `CREATE TABLE IF NOT EXISTS feeds (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        url TEXT NOT NULL,
        state_code TEXT NOT NULL DEFAULT 'KY',
        default_county TEXT,
        region_scope TEXT NOT NULL DEFAULT 'ky',
        fetch_mode TEXT NOT NULL DEFAULT 'rss',
        scraper_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        etag TEXT,
        last_modified TEXT,
        last_checked_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        guid TEXT,
        author TEXT,
        region_scope TEXT NOT NULL DEFAULT 'ky',
        published_at TEXT,
        summary TEXT,
        content TEXT,
        image_url TEXT,
        fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
        hash TEXT,
        article_checked_at TEXT,
        article_fetch_status TEXT,
        article_text_excerpt TEXT
      )`
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS feed_items (
        feed_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        PRIMARY KEY (feed_id, item_id),
        FOREIGN KEY (feed_id) REFERENCES feeds(id) ON DELETE CASCADE,
        FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
      )`
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS item_locations (
        item_id TEXT NOT NULL,
        state_code TEXT NOT NULL,
        county TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (item_id, state_code, county),
        FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
      )`
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS fetch_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        source TEXT,
        details_json TEXT
      )`
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS fetch_errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        feed_id TEXT,
        at TEXT NOT NULL,
        error TEXT NOT NULL
      )`
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS weather_forecasts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        state_code TEXT NOT NULL,
        county TEXT NOT NULL,
        forecast_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
      )`
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS weather_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_id TEXT NOT NULL,
        state_code TEXT NOT NULL,
        county TEXT NOT NULL,
        severity TEXT,
        event TEXT,
        headline TEXT,
        starts_at TEXT,
        ends_at TEXT,
        raw_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS lost_found_posts (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('lost', 'found')),
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        county TEXT NOT NULL,
        state_code TEXT NOT NULL DEFAULT 'KY',
        contact_email_encrypted TEXT NOT NULL,
        show_contact INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
        submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
        approved_at TEXT,
        rejected_at TEXT,
        is_resolved INTEGER NOT NULL DEFAULT 0,
        resolved_at TEXT,
        resolved_note TEXT,
        expires_at TEXT NOT NULL,
        moderation_note TEXT
      )`
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS lost_found_images (
        id TEXT PRIMARY KEY,
        post_id TEXT NOT NULL,
        r2_key TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (post_id) REFERENCES lost_found_posts(id) ON DELETE CASCADE
      )`
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS lost_found_reports (
        id TEXT PRIMARY KEY,
        post_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        reporter_ip_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (post_id) REFERENCES lost_found_posts(id) ON DELETE CASCADE
      )`
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS admin_audit_log (
        id TEXT PRIMARY KEY,
        actor_email TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS item_ai_summaries (
        item_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        model TEXT,
        source_hash TEXT,
        generated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
      )`
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS item_media (
        item_id TEXT PRIMARY KEY,
        source_url TEXT NOT NULL,
        r2_key TEXT NOT NULL,
        content_type TEXT,
        bytes INTEGER,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
      )`
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS summary_review_queue (
        item_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'edited')),
        queue_reason TEXT,
        reviewer_email TEXT,
        reviewed_at TEXT,
        reviewed_summary TEXT,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
      )`
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS item_tag_corrections (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        actor_email TEXT NOT NULL,
        previous_tags_json TEXT,
        new_tags_json TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
      )`
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS feed_run_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER,
        feed_id TEXT NOT NULL,
        source TEXT,
        status TEXT NOT NULL,
        http_status INTEGER,
        duration_ms INTEGER,
        items_seen INTEGER NOT NULL DEFAULT 0,
        items_upserted INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        checked_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (run_id) REFERENCES fetch_runs(id) ON DELETE SET NULL
      )`
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS ingestion_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER,
        source TEXT,
        status TEXT NOT NULL,
        feeds_processed INTEGER NOT NULL DEFAULT 0,
        feeds_updated INTEGER NOT NULL DEFAULT 0,
        items_seen INTEGER NOT NULL DEFAULT 0,
        items_upserted INTEGER NOT NULL DEFAULT 0,
        summaries_generated INTEGER NOT NULL DEFAULT 0,
        images_mirrored INTEGER NOT NULL DEFAULT 0,
        errors INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (run_id) REFERENCES fetch_runs(id) ON DELETE SET NULL
      )`
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS app_error_events (
        id TEXT PRIMARY KEY,
        request_id TEXT,
        route TEXT,
        method TEXT,
        status_code INTEGER,
        actor_email TEXT,
        error_message TEXT NOT NULL,
        error_stack TEXT,
        meta_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT
      )`
    },
    { sql: "CREATE INDEX IF NOT EXISTS idx_items_published_at ON items(published_at)" },
    { sql: "CREATE INDEX IF NOT EXISTS idx_items_url ON items(url)" },
    { sql: "CREATE INDEX IF NOT EXISTS idx_items_region_scope ON items(region_scope)" },
    { sql: "CREATE INDEX IF NOT EXISTS idx_items_published_id ON items(published_at, id)" },
    { sql: "CREATE INDEX IF NOT EXISTS idx_items_fetched_id ON items(fetched_at, id)" },
    { sql: "CREATE INDEX IF NOT EXISTS idx_feed_items_feed ON feed_items(feed_id)" },
    { sql: "CREATE INDEX IF NOT EXISTS idx_feed_items_item ON feed_items(item_id)" },
    { sql: "CREATE INDEX IF NOT EXISTS idx_item_locations_state ON item_locations(state_code)" },
    { sql: "CREATE INDEX IF NOT EXISTS idx_item_locations_county ON item_locations(state_code, county)" },
    { sql: "CREATE INDEX IF NOT EXISTS idx_item_locations_item ON item_locations(item_id)" },
    { sql: "CREATE INDEX IF NOT EXISTS idx_feeds_region_scope ON feeds(region_scope)" },
    { sql: "CREATE INDEX IF NOT EXISTS idx_weather_forecasts_county ON weather_forecasts(state_code, county, fetched_at)" },
    { sql: "CREATE INDEX IF NOT EXISTS idx_weather_alerts_state_county ON weather_alerts(state_code, county, fetched_at)" },
    { sql: "CREATE INDEX IF NOT EXISTS idx_weather_alerts_alert_id ON weather_alerts(alert_id)" },
    { sql: "CREATE INDEX IF NOT EXISTS idx_lost_found_posts_status ON lost_found_posts(status, submitted_at)" },
    { sql: "CREATE INDEX IF NOT EXISTS idx_lost_found_posts_county ON lost_found_posts(state_code, county, status)" },
    { sql: "CREATE INDEX IF NOT EXISTS idx_lost_found_images_post_id ON lost_found_images(post_id)" },
    { sql: "CREATE INDEX IF NOT EXISTS idx_lost_found_reports_post_id ON lost_found_reports(post_id, created_at)" },
    { sql: "CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at)" },
    { sql: "CREATE INDEX IF NOT EXISTS idx_item_ai_generated ON item_ai_summaries(generated_at)" },
    { sql: "CREATE INDEX IF NOT EXISTS idx_summary_review_status_created ON summary_review_queue(status, created_at)" },
    { sql: "CREATE INDEX IF NOT EXISTS idx_tag_corrections_item_created ON item_tag_corrections(item_id, created_at)" },
    { sql: "CREATE INDEX IF NOT EXISTS idx_feed_run_metrics_feed_checked ON feed_run_metrics(feed_id, checked_at)" },
    { sql: "CREATE INDEX IF NOT EXISTS idx_feed_run_metrics_status_checked ON feed_run_metrics(status, checked_at)" },
    { sql: "CREATE INDEX IF NOT EXISTS idx_ingestion_metrics_created ON ingestion_metrics(created_at)" },
    { sql: "CREATE INDEX IF NOT EXISTS idx_app_error_events_created ON app_error_events(created_at)" },
    { sql: "CREATE INDEX IF NOT EXISTS idx_app_error_events_route_created ON app_error_events(route, created_at)" }
  ]);

  await addColumnIfMissing(db, "feeds", "region_scope", "TEXT NOT NULL DEFAULT 'ky'");
  await addColumnIfMissing(db, "feeds", "default_county", "TEXT");
  await addColumnIfMissing(db, "feeds", "fetch_mode", "TEXT NOT NULL DEFAULT 'rss'");
  await addColumnIfMissing(db, "feeds", "scraper_id", "TEXT");
  await d1Run(
    db,
    "UPDATE feeds SET fetch_mode='rss' WHERE fetch_mode IS NULL OR trim(fetch_mode)=''"
  );
  await d1Run(db, "CREATE INDEX IF NOT EXISTS idx_feeds_fetch_mode_enabled ON feeds(fetch_mode, enabled)");
  await addColumnIfMissing(db, "items", "region_scope", "TEXT NOT NULL DEFAULT 'ky'");
  await addColumnIfMissing(db, "items", "article_checked_at", "TEXT");
  await addColumnIfMissing(db, "items", "article_fetch_status", "TEXT");
  await addColumnIfMissing(db, "items", "article_text_excerpt", "TEXT");
  await addColumnIfMissing(db, "lost_found_posts", "is_resolved", "INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing(db, "lost_found_posts", "resolved_at", "TEXT");
  await addColumnIfMissing(db, "lost_found_posts", "resolved_note", "TEXT");
  await d1Run(db, "CREATE INDEX IF NOT EXISTS idx_lost_found_posts_resolved ON lost_found_posts(is_resolved, submitted_at)");
}

export function ensureSchema(env: Env): Promise<void> {
  if (!schemaReady) {
    schemaReady = createCoreSchema(env).catch((err) => {
      schemaReady = null;
      logError("schema.init.failed", err);
      throw err;
    });
  }
  return schemaReady;
}

export async function ensureSchemaFresh(env: Env): Promise<void> {
  schemaReady = null;
  await ensureSchema(env);
}
