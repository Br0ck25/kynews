import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const root = path.resolve(process.cwd());
const dataDir = path.join(root, "data");
const dbPath = path.join(dataDir, "dev.sqlite");

fs.mkdirSync(dataDir, { recursive: true });
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const db = new Database(dbPath);

db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS feeds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  url TEXT NOT NULL,
  state_code TEXT NOT NULL DEFAULT 'KY',
  default_county TEXT,
  region_scope TEXT NOT NULL DEFAULT 'ky',
  enabled INTEGER NOT NULL DEFAULT 1,
  etag TEXT,
  last_modified TEXT,
  last_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS items (
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
);

CREATE TABLE IF NOT EXISTS feed_items (
  feed_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  PRIMARY KEY (feed_id, item_id),
  FOREIGN KEY (feed_id) REFERENCES feeds(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);

-- Location tags: state_code always present; county = '' means "state-level only"
CREATE TABLE IF NOT EXISTS item_locations (
  item_id TEXT NOT NULL,
  state_code TEXT NOT NULL,
  county TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (item_id, state_code, county),
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_items_published_at ON items(published_at);
CREATE INDEX IF NOT EXISTS idx_items_url ON items(url);
CREATE INDEX IF NOT EXISTS idx_items_region_scope ON items(region_scope);
CREATE INDEX IF NOT EXISTS idx_item_locations_state ON item_locations(state_code);
CREATE INDEX IF NOT EXISTS idx_item_locations_county ON item_locations(state_code, county);
CREATE INDEX IF NOT EXISTS idx_feed_items_feed ON feed_items(feed_id);
CREATE INDEX IF NOT EXISTS idx_feeds_region_scope ON feeds(region_scope);

CREATE TABLE IF NOT EXISTS fetch_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fetch_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id TEXT,
  at TEXT NOT NULL,
  error TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS weather_forecasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  state_code TEXT NOT NULL,
  county TEXT NOT NULL,
  forecast_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_weather_forecasts_county ON weather_forecasts(state_code, county, fetched_at);

CREATE TABLE IF NOT EXISTS weather_alerts (
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
);

CREATE INDEX IF NOT EXISTS idx_weather_alerts_state_county ON weather_alerts(state_code, county, fetched_at);
CREATE INDEX IF NOT EXISTS idx_weather_alerts_alert_id ON weather_alerts(alert_id);

CREATE TABLE IF NOT EXISTS lost_found_posts (
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
  expires_at TEXT NOT NULL,
  moderation_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_lost_found_posts_status ON lost_found_posts(status, submitted_at);
CREATE INDEX IF NOT EXISTS idx_lost_found_posts_county ON lost_found_posts(state_code, county, status);

CREATE TABLE IF NOT EXISTS lost_found_images (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (post_id) REFERENCES lost_found_posts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_lost_found_images_post_id ON lost_found_images(post_id);

CREATE TABLE IF NOT EXISTS lost_found_reports (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  reporter_ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (post_id) REFERENCES lost_found_posts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_lost_found_reports_post_id ON lost_found_reports(post_id, created_at);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id TEXT PRIMARY KEY,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at);
`);

db.close();
console.log("✅ DB reset:", dbPath);
