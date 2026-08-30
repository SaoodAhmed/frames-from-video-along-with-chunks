-- Format-independent optimization variants.
-- Identity = (job_id, media_type, format): same-format re-optimization upserts the
-- existing row + R2 key; a different format is a separate row that survives.
-- Apply each statement individually via the D1 query API.

CREATE TABLE IF NOT EXISTS optimizations (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  media_type    TEXT NOT NULL,              -- 'image' | 'video'
  format        TEXT NOT NULL,              -- webp/avif/jpg/png | mp4/mkv/webm
  codec         TEXT,
  crf           INTEGER,
  quality       INTEGER,
  max_dim       INTEGER,
  r2_key        TEXT NOT NULL,
  size          INTEGER,
  duration      REAL,
  status        TEXT NOT NULL DEFAULT 'queued', -- queued/processing/completed/failed/cancelled
  error_message TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  completed_at  TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_opt_variant
  ON optimizations(job_id, media_type, format);

CREATE INDEX IF NOT EXISTS idx_opt_status ON optimizations(status);
