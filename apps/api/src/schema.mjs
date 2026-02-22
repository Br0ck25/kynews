export function columnExists(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

export function ensureSchema(db) {
  if (!columnExists(db, "feeds", "region_scope")) {
    db.prepare("ALTER TABLE feeds ADD COLUMN region_scope TEXT NOT NULL DEFAULT 'ky'").run();
  }
  if (!columnExists(db, "feeds", "default_county")) {
    db.prepare("ALTER TABLE feeds ADD COLUMN default_county TEXT").run();
  }

  if (!columnExists(db, "items", "region_scope")) {
    db.prepare("ALTER TABLE items ADD COLUMN region_scope TEXT NOT NULL DEFAULT 'ky'").run();
  }
  if (!columnExists(db, "items", "article_fetch_status")) {
    db.prepare("ALTER TABLE items ADD COLUMN article_fetch_status TEXT").run();
  }
  if (!columnExists(db, "items", "article_text_excerpt")) {
    db.prepare("ALTER TABLE items ADD COLUMN article_text_excerpt TEXT").run();
  }
  if (!columnExists(db, "items", "ai_summary")) {
    db.prepare("ALTER TABLE items ADD COLUMN ai_summary TEXT").run();
  }

  db.exec(`
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

    CREATE INDEX IF NOT EXISTS idx_items_region_scope ON items(region_scope);
    CREATE INDEX IF NOT EXISTS idx_feeds_region_scope ON feeds(region_scope);
  `);
}
