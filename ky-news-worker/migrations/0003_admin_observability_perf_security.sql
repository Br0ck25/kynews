PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS summary_review_queue (
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
);

CREATE TABLE IF NOT EXISTS item_tag_corrections (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  previous_tags_json TEXT,
  new_tags_json TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS feed_run_metrics (
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
);

CREATE TABLE IF NOT EXISTS ingestion_metrics (
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
);

CREATE TABLE IF NOT EXISTS app_error_events (
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
);

CREATE INDEX IF NOT EXISTS idx_items_published_id ON items(published_at, id);
CREATE INDEX IF NOT EXISTS idx_items_fetched_id ON items(fetched_at, id);
CREATE INDEX IF NOT EXISTS idx_summary_review_status_created ON summary_review_queue(status, created_at);
CREATE INDEX IF NOT EXISTS idx_tag_corrections_item_created ON item_tag_corrections(item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_feed_run_metrics_feed_checked ON feed_run_metrics(feed_id, checked_at);
CREATE INDEX IF NOT EXISTS idx_feed_run_metrics_status_checked ON feed_run_metrics(status, checked_at);
CREATE INDEX IF NOT EXISTS idx_ingestion_metrics_created ON ingestion_metrics(created_at);
CREATE INDEX IF NOT EXISTS idx_app_error_events_created ON app_error_events(created_at);
CREATE INDEX IF NOT EXISTS idx_app_error_events_route_created ON app_error_events(route, created_at);
