-- migration 0017: add update_count to weather_alert_posts
-- Tracks how many update comments have been posted on a given anchor post.
-- Informational only; defaults to 0 for all existing rows.

ALTER TABLE weather_alert_posts ADD COLUMN update_count INTEGER NOT NULL DEFAULT 0;
