-- KENDUIT chunks + export kind
-- Apply:  wrangler d1 migrations apply DB --remote

CREATE TABLE IF NOT EXISTS chunks (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  chunk_number INTEGER NOT NULL,
  start_sec    REAL NOT NULL,
  end_sec      REAL NOT NULL,
  duration     REAL NOT NULL,
  r2_key       TEXT NOT NULL,
  file_size    INTEGER NOT NULL DEFAULT 0,
  width        INTEGER,
  height       INTEGER,
  source_fps   REAL,
  deleted      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_job_id      ON chunks(job_id);
CREATE INDEX IF NOT EXISTS idx_chunks_job_deleted ON chunks(job_id, deleted);

-- Independent chunk-processing state on the job (job.status stays 'completed').
ALTER TABLE jobs ADD COLUMN chunk_status    TEXT NOT NULL DEFAULT 'none';
ALTER TABLE jobs ADD COLUMN chunk_count     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN chunk_processed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN chunk_total     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN chunk_error     TEXT;

-- Exports can now bundle either frames or chunk videos.
ALTER TABLE exports ADD COLUMN kind      TEXT NOT NULL DEFAULT 'frames';
ALTER TABLE exports ADD COLUMN chunk_ids TEXT;
