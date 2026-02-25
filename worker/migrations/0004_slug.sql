-- Migration 0004: Add slug column for SEO-friendly article URLs
-- Slug is derived from the article title + id: e.g. "school-board-meeting-hazard-ky-1234"
-- Nullable to allow migration without backfilling existing rows immediately.
-- After deployment run: UPDATE articles SET slug = lower(replace(substr(title,1,60),' ','-')) || '-' || id
--   WHERE slug IS NULL;

ALTER TABLE articles ADD COLUMN slug TEXT;

-- Index for slug lookups (for future /article/:slug routing)
CREATE INDEX IF NOT EXISTS idx_articles_slug ON articles (slug);
