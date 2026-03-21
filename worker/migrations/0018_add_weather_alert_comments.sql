-- Track every comment posted to a weather alert Facebook anchor post.
-- comment_type: 'update' | 'cancel' | 'expiry' | 'chain_transition'
CREATE TABLE IF NOT EXISTS weather_alert_comments (
  id           INTEGER   PRIMARY KEY AUTOINCREMENT,
  fb_post_id   TEXT      NOT NULL,
  ugc_code     TEXT,
  event        TEXT      NOT NULL,
  area         TEXT      NOT NULL,
  comment_type TEXT      NOT NULL,
  comment_text TEXT      NOT NULL,
  created_at   DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP
);
