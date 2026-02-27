-- add is_national column if it doesn't already exist; running
-- this on a database where the column is missing will create it.  If the
-- column is already present the ALTER will fail, so we expect production to
-- either run this manually or already have the column in place before
-- applying the migration.
ALTER TABLE articles ADD COLUMN is_national INTEGER NOT NULL DEFAULT 0
  CHECK (is_national IN (0,1));

-- add index for weather/national queries
CREATE INDEX IF NOT EXISTS idx_articles_is_national_category
  ON articles (is_national, category);
