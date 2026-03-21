-- migration 0016: add fb_post_id to weather_alert_posts
-- Stores the Facebook post ID returned when the alert was first posted,
-- enabling comment threading for updates and expiry notices.

ALTER TABLE weather_alert_posts ADD COLUMN fb_post_id TEXT;
