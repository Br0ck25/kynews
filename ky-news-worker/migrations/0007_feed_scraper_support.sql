-- Feed-level scraper mode support for outlets without stable RSS.
ALTER TABLE feeds ADD COLUMN fetch_mode TEXT NOT NULL DEFAULT 'rss';
ALTER TABLE feeds ADD COLUMN scraper_id TEXT;

UPDATE feeds
SET fetch_mode = 'rss'
WHERE fetch_mode IS NULL OR trim(fetch_mode) = '';

CREATE INDEX IF NOT EXISTS idx_feeds_fetch_mode_enabled ON feeds(fetch_mode, enabled);

-- Non-RSS / bot-fragile outlet entries powered by custom scraper handlers.
INSERT INTO feeds (
  id,
  name,
  category,
  url,
  state_code,
  default_county,
  region_scope,
  fetch_mode,
  scraper_id,
  enabled
)
VALUES
  (
    'ky-courier-journal-news-scrape',
    'Courier Journal News (Scrape)',
    'Kentucky - Statewide',
    'https://www.courier-journal.com/news/',
    'KY',
    NULL,
    'ky',
    'scrape',
    'gannett-story',
    1
  ),
  (
    'ky-courier-journal-politics-scrape',
    'Courier Journal Politics (Scrape)',
    'Kentucky - Politics',
    'https://www.courier-journal.com/news/politics/',
    'KY',
    NULL,
    'ky',
    'scrape',
    'gannett-story',
    1
  ),
  (
    'ky-commonwealth-journal-scrape',
    'Commonwealth Journal (Scrape)',
    'Kentucky - Local',
    'https://www.somerset-kentucky.com/news/',
    'KY',
    'Pulaski',
    'ky',
    'scrape',
    'townnews-article',
    1
  ),
  (
    'ky-kentucky-standard-scrape',
    'Kentucky Standard (Scrape)',
    'Kentucky - Local',
    'https://www.kystandard.com/news/',
    'KY',
    'Nelson',
    'ky',
    'scrape',
    'townnews-article',
    1
  ),
  (
    'ky-kentuckycom-news-scrape',
    'Kentucky.com News (Scrape)',
    'Kentucky - Statewide',
    'https://www.kentucky.com/news/',
    'KY',
    NULL,
    'ky',
    'scrape',
    'mcclatchy-article',
    0
  )
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  category = excluded.category,
  url = excluded.url,
  state_code = excluded.state_code,
  default_county = excluded.default_county,
  region_scope = excluded.region_scope,
  fetch_mode = excluded.fetch_mode,
  scraper_id = excluded.scraper_id,
  enabled = excluded.enabled;
