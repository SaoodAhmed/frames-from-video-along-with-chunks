-- Phase 3: email-based R2 folders, any-format optimize config, frame-image optimize batches

ALTER TABLE jobs ADD COLUMN opt_quality INTEGER;      -- image/video quality (85 default)
ALTER TABLE jobs ADD COLUMN opt_codec TEXT;           -- video: libx264 | libsvtav1
ALTER TABLE jobs ADD COLUMN opt_container TEXT;       -- video: mp4 | mkv | webm
ALTER TABLE jobs ADD COLUMN video_thumb_key TEXT;     -- poster for user-gallery video cards

ALTER TABLE exports ADD COLUMN batch_id TEXT;         -- links a frames_opt export to an opt_batch

CREATE TABLE opt_batches (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  format TEXT NOT NULL DEFAULT 'webp',                -- webp|jpeg|avif|png
  max_dim INTEGER,
  quality INTEGER NOT NULL DEFAULT 85,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed','cancelled')),
  total INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  frame_ids TEXT NOT NULL DEFAULT '[]',               -- JSON array of frames.id
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX idx_opt_batches_status ON opt_batches(status);
CREATE INDEX idx_opt_batches_job ON opt_batches(job_id);
