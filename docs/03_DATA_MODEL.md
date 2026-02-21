# Data Model

## Core Tables

### feeds
- `id TEXT PRIMARY KEY`
- `name TEXT NOT NULL`
- `category TEXT NOT NULL`
- `url TEXT NOT NULL`
- `state_code TEXT NOT NULL DEFAULT 'KY'`
- `region_scope TEXT NOT NULL DEFAULT 'ky'`
- `enabled INTEGER NOT NULL DEFAULT 1`
- `etag`, `last_modified`, `last_checked_at`, `created_at`

### items
- `id TEXT PRIMARY KEY`
- `title`, `url`, `guid`, `author`
- `region_scope TEXT NOT NULL DEFAULT 'ky'`
- `published_at`, `summary`, `content`, `image_url`
- `fetched_at`, `hash`
- article enrichment fields: `article_checked_at`, `article_fetch_status`, `article_text_excerpt`

### feed_items
- `(feed_id, item_id) PRIMARY KEY`

### item_locations
- `(item_id, state_code, county) PRIMARY KEY`
- `county=''` represents state-level tag

## Operational Tables
- `fetch_runs`
- `fetch_errors`

## Weather Tables

### weather_forecasts
- `id INTEGER PK`
- `state_code`, `county`
- `forecast_json`
- `fetched_at`, `expires_at`

### weather_alerts
- `id INTEGER PK`
- `alert_id`, `state_code`, `county`
- `severity`, `event`, `headline`
- `starts_at`, `ends_at`
- `raw_json`, `fetched_at`

## Lost & Found Tables

### lost_found_posts
- `id TEXT PK`
- `type ('lost'|'found')`
- `title`, `description`
- `county`, `state_code`
- `contact_email_encrypted`
- `show_contact`
- `status ('pending'|'approved'|'rejected')`
- `submitted_at`, `approved_at`, `rejected_at`
- `expires_at`, `moderation_note`

### lost_found_images
- `id TEXT PK`
- `post_id FK -> lost_found_posts`
- `r2_key`, `width`, `height`, `created_at`

### lost_found_reports
- `id TEXT PK`
- `post_id FK -> lost_found_posts`
- `reason`, `reporter_ip_hash`, `created_at`

### admin_audit_log
- `id TEXT PK`
- `actor_email`
- `action`, `entity_type`, `entity_id`
- `payload_json`, `created_at`

## Retention Defaults
- Forecast cache: 7 days
- Alert cache: 48 hours
- Lost-and-found post expiry: 30 days unless renewed
- Ingestion logs retained until manual cleanup policy introduced
