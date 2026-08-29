-- Phase 4: user-managed nested folders + upload dedup + folder-level exports.
-- Apply each statement individually via the D1 query API.

CREATE TABLE IF NOT EXISTS folders (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES folders(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_folders_user   ON folders(user_id);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);

-- Name unique within the same parent. SQLite UNIQUE treats NULLs as distinct,
-- so parent_id NULL (email root) is normalized to '' for uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_unique
  ON folders(user_id, COALESCE(parent_id, ''), name);

ALTER TABLE jobs ADD COLUMN folder_id TEXT;
ALTER TABLE jobs ADD COLUMN sha256 TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_folder ON jobs(user_id, folder_id);

-- Dedup backstop: one job per (user, folder, sha256).
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedup
  ON jobs(user_id, COALESCE(folder_id, ''), sha256);

ALTER TABLE exports ADD COLUMN folder_id TEXT;
