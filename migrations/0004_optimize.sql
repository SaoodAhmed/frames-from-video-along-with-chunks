-- KENDUIT media optimization
-- Any-format video (H.264 compress) + image (resize + WebP/JPEG).
-- Apply via raw D1 API (see note below) or: wrangler d1 migrations apply DB --remote
-- NOTE: this repo applies migrations manually through the Cloudflare D1 query API;
-- there is no _d1_migrations tracking table, so just run the ALTERs once.

ALTER TABLE jobs ADD COLUMN media_type           TEXT NOT NULL DEFAULT 'video';
ALTER TABLE jobs ADD COLUMN optimize_status      TEXT NOT NULL DEFAULT 'none';
ALTER TABLE jobs ADD COLUMN opt_crf              INTEGER;
ALTER TABLE jobs ADD COLUMN opt_max_dim          INTEGER;
ALTER TABLE jobs ADD COLUMN optimized_key        TEXT;
ALTER TABLE jobs ADD COLUMN optimized_size       INTEGER;
ALTER TABLE jobs ADD COLUMN optimized_duration   REAL;
ALTER TABLE jobs ADD COLUMN optimized_thumb_key  TEXT;
ALTER TABLE jobs ADD COLUMN opt_format           TEXT;
