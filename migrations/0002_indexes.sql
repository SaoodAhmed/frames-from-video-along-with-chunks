-- FrameForge indexes for common query paths

CREATE INDEX IF NOT EXISTS idx_jobs_user_id       ON jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status        ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at    ON jobs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_frames_job_id      ON frames(job_id);
CREATE INDEX IF NOT EXISTS idx_frames_job_deleted ON frames(job_id, deleted);

CREATE INDEX IF NOT EXISTS idx_exports_job_id     ON exports(job_id);
CREATE INDEX IF NOT EXISTS idx_exports_status     ON exports(status);

CREATE INDEX IF NOT EXISTS idx_users_email        ON users(email);
