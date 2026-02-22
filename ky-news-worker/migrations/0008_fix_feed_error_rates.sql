-- =============================================================================
-- 0008_fix_feed_error_rates.sql
--
-- Fixes the feeds reported as "critical" in the Feed Health panel (48h window).
-- Changes:
--   1. CNN RSS deprecated → replace with AP News Top News
--   2. Kentucky.com via McClatchy service → try direct Herald-Leader RSS
--   3. PMG internal routing domains (pmg-ky1/2/3.com) → disable; add Oldham Era
--      with actual public domain
--   4. TownNews CMS papers: switch search-RSS feeds to scrape mode
--   5. TownNews obituary feeds: switch to scrape mode
--   6. Other search-RSS feeds: try standard /feed/ endpoint
--   7. Clear feed_run_metrics + fetch_errors for affected feeds so the admin
--      health dashboard starts with a clean slate (shows "unknown" status until
--      the next successful ingestion run).
--
-- Apply with:
--   npx wrangler d1 execute ky_news_db --file=./migrations/0008_fix_feed_error_rates.sql --remote
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. CNN Top Stories — CNN formally deprecated their public RSS feeds in 2024.
--    Replace with AP News Top News, which is a stable public RSS feed.
-- -----------------------------------------------------------------------------
UPDATE feeds
SET name       = 'AP News - Top Stories',
    url        = 'https://feeds.apnews.com/rss/apf-topnews',
    fetch_mode = 'rss'
WHERE id = 'nat-cnn-top';

-- Disable any other feeds still pointing to rss.cnn.com (e.g. a manually-added
-- "CNN News" feed with category "local").  The AP News feed above covers that slot.
UPDATE feeds
SET enabled = 0
WHERE url LIKE '%rss.cnn.com%' AND id != 'nat-cnn-top';

-- -----------------------------------------------------------------------------
-- 2. Kentucky.com via McClatchy aggregation service
--    feeds.mcclatchy.com is frequently unreliable.  Try the direct
--    Kentucky.com (Lexington Herald-Leader) RSS endpoint instead.
-- -----------------------------------------------------------------------------
UPDATE feeds
SET url = 'https://www.kentucky.com/latest-news/rss/'
WHERE id = 'ky-kentuckycom-homepage';

-- -----------------------------------------------------------------------------
-- 3. Paxton Media Group internal routing domains
--    pmg-ky1.com / pmg-ky2.com / pmg-ky3.com are PMG's private LAN-routing
--    domains and are NOT reachable from public internet / Cloudflare Workers.
--    Disable them all; the Oldham Era is re-added with its actual public domain.
-- -----------------------------------------------------------------------------
UPDATE feeds
SET enabled = 0
WHERE (   url LIKE 'https://www.pmg-ky1.com/%'
       OR url LIKE 'https://www.pmg-ky2.com/%'
       OR url LIKE 'https://www.pmg-ky3.com/%')
  AND enabled = 1;

-- Oldham Era: restore with its real public domain.
UPDATE feeds
SET url     = 'https://www.oldhamera.com/feed/',
    enabled = 1
WHERE id = 'ky-county-oldham-oldham-era';

-- -----------------------------------------------------------------------------
-- 4. Switch TownNews CMS papers from broken search-RSS to scrape mode.
--    The townnews-article scraper has dedicated support (article_XXXX.html URLs,
--    /news/, /sports/, /obituaries/ section crawling).
-- -----------------------------------------------------------------------------

-- Messenger-Inquirer (Owensboro, Daviess County)
UPDATE feeds
SET fetch_mode = 'scrape',
    scraper_id = 'townnews-article',
    url        = 'https://www.messenger-inquirer.com/news/'
WHERE id = 'ky-messenger-inquirer';

-- Paducah Sun (McCracken County)
UPDATE feeds
SET fetch_mode = 'scrape',
    scraper_id = 'townnews-article',
    url        = 'https://www.paducahsun.com/news/'
WHERE id = 'ky-county-mccracken-paducah-sun';

-- Richmond Register (Madison County)
UPDATE feeds
SET fetch_mode = 'scrape',
    scraper_id = 'townnews-article',
    url        = 'https://www.richmondregister.com/news/'
WHERE id = 'ky-county-madison-richmond-register';

-- Kentucky New Era (Hopkinsville, Christian County; also source for Cadiz Record)
UPDATE feeds
SET fetch_mode = 'scrape',
    scraper_id = 'townnews-article',
    url        = 'https://www.kentuckynewera.com/news/'
WHERE id = 'ky-kentuckynewera';

-- Daily Independent (Ashland, Boyd County)
UPDATE feeds
SET fetch_mode = 'scrape',
    scraper_id = 'townnews-article',
    url        = 'https://www.dailyindependent.com/news/'
WHERE id = 'ky-dailyindependent';

-- Floyd County Chronicle and Times (Floyd County)
UPDATE feeds
SET fetch_mode = 'scrape',
    scraper_id = 'townnews-article',
    url        = 'https://www.floydct.com/news/'
WHERE id = 'ky-county-floyd-floyd-county-chronicle';

-- Appalachian News-Express (Pike County)
UPDATE feeds
SET fetch_mode = 'scrape',
    scraper_id = 'townnews-article',
    url        = 'https://www.news-expressky.com/news/'
WHERE id = 'ky-county-pike-appalachian-news-express';

-- Cadiz Record (Trigg County) — published as a section of Kentucky New Era;
-- switch to scrape mode on its KNE section page.
UPDATE feeds
SET fetch_mode = 'scrape',
    scraper_id = 'townnews-article',
    url        = 'https://www.kentuckynewera.com/cadiz_record/'
WHERE id = 'ky-county-trigg-cadiz-record';

-- -----------------------------------------------------------------------------
-- 5. Switch TownNews obituary feeds to scrape mode.
--    The townnews-article scraper crawls /obituaries/ automatically.
-- -----------------------------------------------------------------------------

UPDATE feeds
SET fetch_mode = 'scrape',
    scraper_id = 'townnews-article',
    url        = 'https://www.messenger-inquirer.com/obituaries/'
WHERE id = 'ky-obits-messenger-inquirer';

UPDATE feeds
SET fetch_mode = 'scrape',
    scraper_id = 'townnews-article',
    url        = 'https://www.paducahsun.com/obituaries/'
WHERE id = 'ky-obits-paducahsun';

UPDATE feeds
SET fetch_mode = 'scrape',
    scraper_id = 'townnews-article',
    url        = 'https://www.richmondregister.com/obituaries/'
WHERE id = 'ky-obits-richmondregister';

UPDATE feeds
SET fetch_mode = 'scrape',
    scraper_id = 'townnews-article',
    url        = 'https://www.kentuckynewera.com/obituaries/'
WHERE id = 'ky-obits-kentuckynewera';

UPDATE feeds
SET fetch_mode = 'scrape',
    scraper_id = 'townnews-article',
    url        = 'https://www.dailyindependent.com/obituaries/'
WHERE id = 'ky-obits-dailyindependent';

UPDATE feeds
SET fetch_mode = 'scrape',
    scraper_id = 'townnews-article',
    url        = 'https://www.news-expressky.com/obituaries/'
WHERE id = 'ky-obits-news-expressky';

UPDATE feeds
SET fetch_mode = 'scrape',
    scraper_id = 'townnews-article',
    url        = 'https://www.thenewsenterprise.com/obituaries/'
WHERE id = 'ky-obits-newsenterprise';

-- -----------------------------------------------------------------------------
-- 6. Other search-RSS feeds: try standard WordPress /feed/ endpoints.
--    These sites may have migrated their CMS away from the Lee/Civitas search RSS.
-- -----------------------------------------------------------------------------

-- Franklin Favorite (Simpson County)
UPDATE feeds
SET url = 'https://www.franklinfavorite.com/feed'
WHERE id = 'ky-county-simpson-franklin-favorite';

-- WDRB Louisville — search-RSS may have changed with station CMS migration
UPDATE feeds
SET url = 'https://www.wdrb.com/news/feed/'
WHERE id = 'ky-wdrb-search';

-- Kentucky Today (Baptist newspaper, statewide)
UPDATE feeds
SET url = 'https://www.kentuckytoday.com/feed'
WHERE id = 'ky-kentuckytoday';

-- The Times Leader (Pikeville)
UPDATE feeds
SET url = 'https://www.timesleader.net/feed'
WHERE id = 'ky-timesleader';

-- -----------------------------------------------------------------------------
-- 7. Reset metrics for all changed feeds so the health dashboard starts fresh.
--    Feeds will show "unknown" status until their next successful ingestion run,
--    which is far preferable to carrying forward stale 80–100 % error rates.
-- -----------------------------------------------------------------------------

DELETE FROM feed_run_metrics
WHERE feed_id IN (
  'nat-cnn-top',
  'ky-kentuckycom-homepage',
  'ky-messenger-inquirer',
  'ky-county-mccracken-paducah-sun',
  'ky-county-madison-richmond-register',
  'ky-kentuckynewera',
  'ky-dailyindependent',
  'ky-county-floyd-floyd-county-chronicle',
  'ky-county-pike-appalachian-news-express',
  'ky-county-trigg-cadiz-record',
  'ky-county-larue-larue-county-herald-ne',
  'ky-county-marion-lebanon-enterprise',
  'ky-county-oldham-oldham-era',
  'ky-county-simpson-franklin-favorite',
  'ky-wdrb-search',
  'ky-kentuckytoday',
  'ky-timesleader',
  'ky-nkytribune',
  'ky-obits-messenger-inquirer',
  'ky-obits-paducahsun',
  'ky-obits-richmondregister',
  'ky-obits-kentuckynewera',
  'ky-obits-dailyindependent',
  'ky-obits-news-expressky',
  'ky-obits-newsenterprise'
);

DELETE FROM fetch_errors
WHERE feed_id IN (
  'nat-cnn-top',
  'ky-kentuckycom-homepage',
  'ky-messenger-inquirer',
  'ky-county-mccracken-paducah-sun',
  'ky-county-madison-richmond-register',
  'ky-kentuckynewera',
  'ky-dailyindependent',
  'ky-county-floyd-floyd-county-chronicle',
  'ky-county-pike-appalachian-news-express',
  'ky-county-trigg-cadiz-record',
  'ky-county-larue-larue-county-herald-ne',
  'ky-county-marion-lebanon-enterprise',
  'ky-county-oldham-oldham-era',
  'ky-county-simpson-franklin-favorite',
  'ky-wdrb-search',
  'ky-kentuckytoday',
  'ky-timesleader',
  'ky-nkytribune',
  'ky-obits-messenger-inquirer',
  'ky-obits-paducahsun',
  'ky-obits-richmondregister',
  'ky-obits-kentuckynewera',
  'ky-obits-dailyindependent',
  'ky-obits-news-expresky',
  'ky-obits-newsenterprise'
);
