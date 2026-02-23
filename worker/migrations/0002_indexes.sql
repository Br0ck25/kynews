CREATE INDEX IF NOT EXISTS idx_articles_category_id_desc
  ON articles (category, id DESC);

CREATE INDEX IF NOT EXISTS idx_articles_category_county_id_desc
  ON articles (category, county, id DESC);

CREATE INDEX IF NOT EXISTS idx_articles_is_kentucky_category
  ON articles (is_kentucky, category);

CREATE INDEX IF NOT EXISTS idx_articles_published_at
  ON articles (published_at DESC);

CREATE INDEX IF NOT EXISTS idx_articles_title
  ON articles (title);

CREATE INDEX IF NOT EXISTS idx_articles_county
  ON articles (county);
