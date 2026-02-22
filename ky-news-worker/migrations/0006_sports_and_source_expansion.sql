-- Add missing direct Kentucky sources and sports-focused feeds.
INSERT INTO feeds (id, name, category, url, state_code, default_county, region_scope, enabled)
VALUES
  ('ky-leo-weekly', 'LEO Weekly', 'Kentucky - Culture', 'https://www.leoweekly.com/feed/', 'KY', NULL, 'ky', 1),
  ('ky-hazard-herald', 'Hazard Herald', 'Kentucky - Local', 'https://www.hazard-herald.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc&k%5B%5D=%23topstory', 'KY', 'Perry', 'ky', 1),
  ('ky-weku-news', 'WEKU News', 'Kentucky - Radio', 'https://www.weku.org/news.rss', 'KY', NULL, 'ky', 1),
  ('ky-wnky-news', 'WNKY News', 'Kentucky - TV', 'https://www.wnky.com/feed/', 'KY', NULL, 'ky', 1),
  ('ky-sports-lex18', 'LEX18 Sports', 'Kentucky - Sports', 'https://www.lex18.com/sports.rss', 'KY', NULL, 'ky', 1),
  ('ky-sports-abc36', 'ABC36 Sports', 'Kentucky - Sports', 'https://www.wtvq.com/category/sports/feed/', 'KY', NULL, 'ky', 1),
  ('ky-sports-ukathletics', 'UK Athletics', 'Kentucky - Sports', 'https://ukathletics.com/feed/', 'KY', NULL, 'ky', 1),
  ('ky-sports-gocards', 'Louisville Cardinals Athletics', 'Kentucky - Sports', 'https://gocards.com/rss', 'KY', NULL, 'ky', 1),
  ('nat-sports-espn', 'ESPN Headlines', 'National - Sports', 'https://www.espn.com/espn/rss/news', 'US', NULL, 'national', 1),
  ('nat-sports-cbssports', 'CBS Sports Headlines', 'National - Sports', 'https://www.cbssports.com/rss/headlines/', 'US', NULL, 'national', 1),
  ('nat-sports-yahoo', 'Yahoo Sports', 'National - Sports', 'https://sports.yahoo.com/rss/', 'US', NULL, 'national', 1)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  category = excluded.category,
  url = excluded.url,
  state_code = excluded.state_code,
  default_county = excluded.default_county,
  region_scope = excluded.region_scope,
  enabled = excluded.enabled;
