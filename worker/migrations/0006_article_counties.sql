-- create junction table to support articles belonging to multiple counties
-- runs safely on an existing schema; IF NOT EXISTS guards prevent errors
CREATE TABLE IF NOT EXISTS article_counties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  county TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 1 CHECK (is_primary IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_article_counties_article_id
  ON article_counties(article_id);

CREATE INDEX IF NOT EXISTS idx_article_counties_county
  ON article_counties(county);

CREATE UNIQUE INDEX IF NOT EXISTS idx_article_counties_unique
  ON article_counties(article_id, county);

-- backfill existing articles that have a county value but no junction row
INSERT OR IGNORE INTO article_counties (article_id, county, is_primary)
SELECT id, county, 1 FROM articles WHERE county IS NOT NULL;
