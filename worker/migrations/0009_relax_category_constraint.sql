-- migration 0009: relax the category constraint so empty strings are allowed
-- We rebuild the articles table without the CHECK on category.


ALTER TABLE articles RENAME TO articles_old;

CREATE TABLE articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_url TEXT NOT NULL,
  source_url TEXT NOT NULL,
  url_hash TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  author TEXT,
  published_at TEXT NOT NULL,
  category TEXT NOT NULL,
  is_kentucky INTEGER NOT NULL DEFAULT 0 CHECK (is_kentucky IN (0,1)),
  is_national INTEGER NOT NULL DEFAULT 0 CHECK (is_national IN (0,1)),
  county TEXT,
  city TEXT,
  summary TEXT NOT NULL,
  seo_description TEXT NOT NULL,
  raw_word_count INTEGER NOT NULL DEFAULT 0,
  summary_word_count INTEGER NOT NULL DEFAULT 0,
  content_text TEXT NOT NULL,
  content_html TEXT NOT NULL,
  image_url TEXT,
  raw_r2_key TEXT,
  slug TEXT,
  content_hash TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO articles (
  id, canonical_url, source_url, url_hash, title, author, published_at,
  category, is_kentucky, is_national, county, city, summary, seo_description,
  raw_word_count, summary_word_count, content_text, content_html,
  image_url, raw_r2_key, slug, content_hash, created_at, updated_at
)
SELECT
  id, canonical_url, source_url, url_hash, title, author, published_at,
  category, is_kentucky, is_national, county, city, summary, seo_description,
  raw_word_count, summary_word_count, content_text, content_html,
  image_url, raw_r2_key, slug, content_hash, created_at, updated_at
FROM articles_old;

DROP TABLE articles_old;

