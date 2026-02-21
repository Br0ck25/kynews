-- Disable aggregator-based feeds so ingestion prefers direct publisher/government sources.
UPDATE feeds
SET enabled = 0
WHERE url LIKE 'https://www.bing.com/news/search%'
   OR url LIKE 'https://news.google.com/rss/search%';

-- Add high-signal direct national, government, and Kentucky sources.
INSERT INTO feeds (id, name, category, url, state_code, default_county, region_scope, enabled)
VALUES
  ('nat-pbs-politics', 'PBS NewsHour Politics', 'National - Politics', 'https://www.pbs.org/newshour/feeds/rss/politics', 'US', NULL, 'national', 1),
  ('nat-abc-topstories', 'ABC News Top Stories', 'National - General', 'https://abcnews.go.com/abcnews/topstories', 'US', NULL, 'national', 1),
  ('nat-nbc-topstories', 'NBC News Top Stories', 'National - General', 'https://feeds.nbcnews.com/nbcnews/public/news', 'US', NULL, 'national', 1),
  ('nat-propublica-main', 'ProPublica Main Feed', 'National - Investigative', 'https://www.propublica.org/feeds/propublica/main', 'US', NULL, 'national', 1),
  ('nat-guardian-us', 'The Guardian US News', 'National - General', 'https://www.theguardian.com/us-news/rss', 'US', NULL, 'national', 1),
  ('nat-aljazeera-all', 'Al Jazeera - All News', 'National - World', 'https://www.aljazeera.com/xml/rss/all.xml', 'US', NULL, 'national', 1),
  ('nat-atlantic-all', 'The Atlantic - All Stories', 'National - Analysis', 'https://www.theatlantic.com/feed/all/', 'US', NULL, 'national', 1),
  ('nat-thehill', 'The Hill', 'National - Politics', 'https://thehill.com/feed/', 'US', NULL, 'national', 1),
  ('gov-doj-news', 'U.S. Department of Justice News', 'Government - Justice', 'https://www.justice.gov/feeds/justice-news.xml', 'US', NULL, 'national', 1),
  ('gov-doe-news', 'U.S. Department of Energy News', 'Government - Energy', 'https://www.energy.gov/rss.xml', 'US', NULL, 'national', 1),
  ('gov-fda-press', 'FDA Press Releases', 'Government - Health', 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml', 'US', NULL, 'national', 1),
  ('gov-fda-recalls', 'FDA Recalls', 'Government - Public Safety', 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/recalls/rss.xml', 'US', NULL, 'national', 1),
  ('gov-sec-press', 'SEC Press Releases', 'Government - Markets', 'https://www.sec.gov/news/pressreleases.rss', 'US', NULL, 'national', 1),
  ('gov-nasa-breaking', 'NASA Breaking News', 'Government - Science', 'https://www.nasa.gov/rss/dyn/breaking_news.rss', 'US', NULL, 'national', 1),
  ('gov-fed-press', 'Federal Reserve Press Releases', 'Government - Economy', 'https://www.federalreserve.gov/feeds/press_all.xml', 'US', NULL, 'national', 1),
  ('gov-nist-news', 'NIST News', 'Government - Science', 'https://www.nist.gov/news-events/news/rss.xml', 'US', NULL, 'national', 1),
  ('gov-cdc-travel-notices', 'CDC Travel Health Notices', 'Government - Health', 'https://wwwnc.cdc.gov/travel/rss/notices.xml', 'US', NULL, 'national', 1),
  ('ky-weku-news', 'WEKU News', 'Kentucky - Radio', 'https://www.weku.org/news.rss', 'KY', NULL, 'ky', 1),
  ('ky-wuky-news', 'WUKY News', 'Kentucky - Radio', 'https://www.wuky.org/wuky-news.rss', 'KY', NULL, 'ky', 1)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  category = excluded.category,
  url = excluded.url,
  state_code = excluded.state_code,
  default_county = excluded.default_county,
  region_scope = excluded.region_scope,
  enabled = excluded.enabled;
