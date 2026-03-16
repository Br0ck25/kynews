-- migration 0014: weather alert admin posts
-- Stores NWS alert posts visible in the admin console.
-- nws_alert_id is the stable NWS identifier used for duplicate prevention;
-- it is NULL for manually-written posts.

CREATE TABLE IF NOT EXISTS weather_alert_posts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  nws_alert_id  TEXT    UNIQUE,          -- NWS alert ID (null for manual posts)
  event         TEXT    NOT NULL,
  area          TEXT    NOT NULL DEFAULT '',
  severity      TEXT    NOT NULL DEFAULT 'Unknown',
  expires_at    TEXT,                    -- ISO-8601 string from NWS
  post_text     TEXT    NOT NULL,        -- the editable Facebook-ready copy
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_wap_nws_id   ON weather_alert_posts(nws_alert_id);
CREATE INDEX IF NOT EXISTS idx_wap_created  ON weather_alert_posts(created_at DESC);
