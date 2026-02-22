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
  if (!columnExists(db, "lost_found_posts", "is_resolved")) {
    db.prepare("ALTER TABLE lost_found_posts ADD COLUMN is_resolved INTEGER NOT NULL DEFAULT 0").run();
  }
  if (!columnExists(db, "lost_found_posts", "resolved_at")) {
    db.prepare("ALTER TABLE lost_found_posts ADD COLUMN resolved_at TEXT").run();
  }
  if (!columnExists(db, "lost_found_posts", "resolved_note")) {
    db.prepare("ALTER TABLE lost_found_posts ADD COLUMN resolved_note TEXT").run();
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
      is_resolved INTEGER NOT NULL DEFAULT 0,
      resolved_at TEXT,
      resolved_note TEXT,
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

    CREATE TABLE IF NOT EXISTS lost_found_comments (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      commenter_name TEXT NOT NULL,
      commenter_email_encrypted TEXT NOT NULL,
      commenter_email_hash TEXT NOT NULL,
      comment_text TEXT NOT NULL,
      url_count INTEGER NOT NULL DEFAULT 0,
      commenter_ip_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (post_id) REFERENCES lost_found_posts(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_lost_found_comments_post_created ON lost_found_comments(post_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_lost_found_comments_ip_created ON lost_found_comments(commenter_ip_hash, created_at);

    CREATE TABLE IF NOT EXISTS lost_found_comment_bans (
      id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL CHECK (target_type IN ('email', 'ip')),
      target_hash TEXT NOT NULL,
      reason TEXT,
      banned_by_email TEXT NOT NULL,
      source_comment_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(target_type, target_hash),
      FOREIGN KEY (source_comment_id) REFERENCES lost_found_comments(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_lost_found_comment_bans_created ON lost_found_comment_bans(created_at);

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
