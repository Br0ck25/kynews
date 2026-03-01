-- Ensure published_at and updated_at values use ISO8601 (T separator) rather than a
-- space. Older rows were inserted with plain "%Y-%m-%d %H:%M:%S" strings which
-- break sitemap parsers on "lastmod" tags.

UPDATE articles
SET published_at = replace(published_at, ' ', 'T')
WHERE published_at LIKE '% %' AND published_at NOT LIKE '%T%';

UPDATE articles
SET updated_at = replace(updated_at, ' ', 'T')
WHERE updated_at LIKE '% %' AND updated_at NOT LIKE '%T%';
