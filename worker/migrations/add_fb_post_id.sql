-- Add fb_post_id column to weather_alert_posts.
-- Stores the Facebook post ID returned when the alert was first posted,
-- enabling comment threading for updates and expiry notices.
--
-- NOTE: This migration is superseded by 0016_add_fb_post_id.sql which
-- contains the same statement. Run only one of them against the D1 database.

ALTER TABLE weather_alert_posts ADD COLUMN fb_post_id TEXT;
