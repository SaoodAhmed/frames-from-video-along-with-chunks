-- FrameForge initial schema
-- Apply:  wrangler d1 migrations apply DB --remote

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  original_filename  TEXT NOT NULL,
  r2_video_key       TEXT NOT NULL,
  file_size          INTEGER NOT NULL DEFAULT 0,
  mime_type          TEXT NOT NULL DEFAULT 'video/mp4',
  status             TEXT NOT NULL DEFAULT 'uploaded'
                     CHECK (status IN ('uploaded', 'queued', 'processing', 'completed', 'failed', 'cancelled')),
  source_fps         REAL,
  duration           REAL,
  width              INTEGER,
  height             INTEGER,
  total_source_frames INTEGER,
  extraction_fps     REAL,
  extraction_mode    TEXT,
  sharpness          REAL,
  scene_threshold    REAL,
  extracted_frames   INTEGER NOT NULL DEFAULT 0,
  processed_frames   INTEGER NOT NULL DEFAULT 0,
  error_message      TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  completed_at       TEXT
);

CREATE TABLE IF NOT EXISTS frames (
  id                 TEXT PRIMARY KEY,
  job_id             TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  frame_number       INTEGER NOT NULL,
  source_frame_number INTEGER NOT NULL,
  timestamp          REAL NOT NULL,
  r2_key             TEXT NOT NULL,
  width              INTEGER NOT NULL,
  height             INTEGER NOT NULL,
  deleted            INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exports (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  export_type   TEXT NOT NULL CHECK (export_type IN ('all', 'selected')),
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  r2_key        TEXT,
  file_size     INTEGER,
  frame_count   INTEGER,
  frame_ids     TEXT,
  error_message TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  completed_at  TEXT
);
