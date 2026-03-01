-- migration 0008: add content_hash column to articles table

ALTER TABLE articles ADD COLUMN content_hash TEXT;
