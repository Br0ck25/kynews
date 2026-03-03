-- Migration 0010: flush the D1 remote prepared-statement cache.
--
-- After migration 0009 renamed articles → articles_old → articles, Cloudflare
-- D1's server-side statement cache sometimes retains execution plans that were
-- compiled during the brief window when articles_old existed.  Every subsequent
-- UPDATE/SELECT on `articles` then fails with:
--   D1_ERROR: no such table: main.articles_old
--
-- Performing one more rename cycle forces SQLite (and D1's cache layer) to
-- recompile all statements that reference the `articles` table.  No data is
-- moved or altered — this is purely a schema-level cache bust.

ALTER TABLE articles RENAME TO articles_flush;
ALTER TABLE articles_flush RENAME TO articles;
