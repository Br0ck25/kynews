-- Migration 0013: add image dimension columns to the articles table.
-- These nullable INTEGER fields store the actual pixel dimensions of the
-- article's og:image so the meta tags can serve accurate values instead of
-- the previously-hardcoded 1200×630 defaults.
ALTER TABLE articles ADD COLUMN image_width INTEGER;
ALTER TABLE articles ADD COLUMN image_height INTEGER;
