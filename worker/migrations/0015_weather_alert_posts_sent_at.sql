-- migration 0015: add sent_at to weather_alert_posts
-- Stores the NWS `properties.sent` timestamp so alerts fetched in the same
-- second can be sorted by their actual issuance time.

ALTER TABLE weather_alert_posts ADD COLUMN sent_at TEXT;
