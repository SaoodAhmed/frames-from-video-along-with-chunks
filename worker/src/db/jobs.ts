import type { D1Database } from "@cloudflare/workers-types";
import { canTransition, canTransitionChunk, canTransitionOptimize } from "../types";
import type { Job, JobStatus, Chunk, ChunkStatus, OptimizeStatus } from "../types";

const JOB_FIELDS = `id, user_id, folder_id, sha256, original_filename, r2_video_key, file_size, mime_type,
  media_type, status, source_fps, duration, width, height, total_source_frames, extraction_fps,
  extraction_mode, sharpness, scene_threshold, extracted_frames, processed_frames,
  error_message, chunk_status, chunk_count, chunk_processed, chunk_total, chunk_error,
  optimize_status, opt_crf, opt_max_dim, opt_quality, opt_codec, opt_container,
  optimized_key, optimized_size, optimized_duration, optimized_thumb_key, opt_format,
  video_thumb_key, created_at, updated_at, completed_at`;

const CHUNK_FIELDS = `id, job_id, chunk_number, start_sec, end_sec, duration, r2_key,
  file_size, width, height, source_fps, deleted, created_at`;

export async function getJob(db: D1Database, jobId: string): Promise<Job | null> {
  const row = await db
    .prepare(`SELECT ${JOB_FIELDS} FROM jobs WHERE id = ?`)
    .bind(jobId)
    .first<Job>();
  return row ?? null;
}

export async function getJobForUser(
  db: D1Database,
  userId: string,
  jobId: string
): Promise<Job | null> {
  const row = await db
    .prepare(`SELECT ${JOB_FIELDS} FROM jobs WHERE id = ? AND user_id = ?`)
    .bind(jobId, userId)
    .first<Job>();
  return row ?? null;
}

export async function createJob(
  db: D1Database,
  input: {
    id: string;
    user_id: string;
    folder_id?: string | null;
    sha256?: string | null;
    original_filename: string;
    r2_video_key: string;
    file_size: number;
    mime_type: string;
    media_type?: "video" | "image";
    optimize_status?: OptimizeStatus;
  }
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO jobs (id, user_id, folder_id, sha256, original_filename, r2_video_key,
        file_size, mime_type, media_type, optimize_status, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploaded', ?, ?)`
    )
    .bind(
      input.id,
      input.user_id,
      input.folder_id ?? null,
      input.sha256 ?? null,
      input.original_filename,
      input.r2_video_key,
      input.file_size,
      input.mime_type,
      input.media_type ?? "video",
      input.optimize_status ?? "none",
      now,
      now
    )
    .run();
}

/**
 * Atomic status transition. The WHERE clause on the current status prevents
 * invalid or racing transitions; returns false when the transition is not allowed.
 */
export async function transitionJob(
  db: D1Database,
  jobId: string,
  from: JobStatus,
  to: JobStatus,
  extra?: Record<string, string | number | null>
): Promise<boolean> {
  if (!canTransition(from, to)) return false;
  const now = new Date().toISOString();
  const sets = ["status = ?", "updated_at = ?"];
  const vals: unknown[] = [to, now];
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
  }
  if (to === "completed") {
    sets.push("completed_at = ?");
    vals.push(now);
  }
  vals.push(jobId, from);
  const res = await db
    .prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ? AND status = ?`)
    .bind(...vals)
    .run();
  return res.meta.changes > 0;
}

export interface JobListRow extends Job {
  user_email: string;
}

export async function listUserJobs(db: D1Database, userId: string): Promise<Job[]> {
  const rows = await db
    .prepare(
      `SELECT ${JOB_FIELDS} FROM jobs WHERE user_id = ? ORDER BY created_at DESC`
    )
    .bind(userId)
    .all<Job>();
  return rows.results ?? [];
}

/**
 * User gallery listing with folder + media-type filters and pagination.
 * folderId null => the email root (folder_id IS NULL). Pass folderId undefined
 * to include every folder (the "All Media" root view).
 */
export async function listUserJobsFiltered(
  db: D1Database,
  userId: string,
  opts: { folderId?: string | null; mediaType?: "image" | "video"; page: number; perPage: number }
): Promise<{ rows: Job[]; total: number }> {
  const where: string[] = ["user_id = ?"];
  const params: unknown[] = [userId];

  if (opts.folderId !== undefined) {
    where.push("COALESCE(folder_id, '') = ?");
    params.push(opts.folderId ?? "");
  }
  if (opts.mediaType) {
    where.push("media_type = ?");
    params.push(opts.mediaType);
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;
  const count = await db
    .prepare(`SELECT COUNT(*) AS n FROM jobs ${whereSql}`)
    .bind(...params)
    .first<{ n: number }>();

  const rows = await db
    .prepare(`SELECT ${JOB_FIELDS} FROM jobs ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...params, opts.perPage, (opts.page - 1) * opts.perPage)
    .all<Job>();

  return { rows: rows.results ?? [], total: count?.n ?? 0 };
}

export async function listAllJobs(
  db: D1Database,
  opts: {
    status?: string;
    search?: string;
    mediaType?: "image" | "video";
    limit: number;
    offset: number;
  }
): Promise<{ rows: JobListRow[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.status) {
    where.push("j.status = ?");
    params.push(opts.status);
  }
  if (opts.search) {
    where.push("(j.original_filename LIKE ? OR u.email LIKE ?)");
    params.push(`%${opts.search}%`, `%${opts.search}%`);
  }
  if (opts.mediaType) {
    where.push("j.media_type = ?");
    params.push(opts.mediaType);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const countRes = await db
    .prepare(`SELECT COUNT(*) AS n FROM jobs j LEFT JOIN users u ON u.id = j.user_id ${whereSql}`)
    .bind(...params)
    .first<{ n: number }>();

  const rows = await db
    .prepare(
      `SELECT ${JOB_FIELDS.split(/[\s,]+/)
        .filter(Boolean)
        .map((f) => `j.${f}`)
        .join(", ")}, u.email AS user_email
       FROM jobs j LEFT JOIN users u ON u.id = j.user_id
       ${whereSql}
       ORDER BY j.created_at DESC LIMIT ? OFFSET ?`
    )
    .bind(...params, opts.limit, opts.offset)
    .all<JobListRow>();

  return { rows: rows.results ?? [], total: countRes?.n ?? 0 };
}

export async function countJobsByStatus(db: D1Database): Promise<Record<string, number>> {
  const rows = await db
    .prepare(`SELECT status, COUNT(*) AS n FROM jobs GROUP BY status`)
    .all<{ status: string; n: number }>();
  const out: Record<string, number> = {};
  for (const r of rows.results ?? []) out[r.status] = r.n;
  return out;
}

// ── Chunks ───────────────────────────────────────────────────────────────────

export async function getChunk(db: D1Database, chunkId: string): Promise<Chunk | null> {
  const row = await db
    .prepare(`SELECT ${CHUNK_FIELDS} FROM chunks WHERE id = ?`)
    .bind(chunkId)
    .first<Chunk>();
  return row ?? null;
}

export async function listChunks(
  db: D1Database,
  jobId: string,
  opts: { page: number; perPage: number; includeDeleted?: boolean }
): Promise<{ rows: Chunk[]; total: number }> {
  const whereDeleted = opts.includeDeleted ? "" : "AND deleted = 0";
  const count = await db
    .prepare(`SELECT COUNT(*) AS n FROM chunks WHERE job_id = ? ${whereDeleted}`)
    .bind(jobId)
    .first<{ n: number }>();
  const rows = await db
    .prepare(
      `SELECT ${CHUNK_FIELDS} FROM chunks WHERE job_id = ? ${whereDeleted}
       ORDER BY chunk_number ASC LIMIT ? OFFSET ?`
    )
    .bind(jobId, opts.perPage, (opts.page - 1) * opts.perPage)
    .all<Chunk>();
  return { rows: rows.results ?? [], total: count?.n ?? 0 };
}

/** Live (non-deleted) chunk R2 keys for a job, ordered by chunk_number. */
export async function listChunkKeys(db: D1Database, jobId: string): Promise<{ id: string; r2_key: string; chunk_number: number }[]> {
  const rows = await db
    .prepare(`SELECT id, r2_key, chunk_number FROM chunks WHERE job_id = ? AND deleted = 0 ORDER BY chunk_number ASC`)
    .bind(jobId)
    .all<{ id: string; r2_key: string; chunk_number: number }>();
  return rows.results ?? [];
}

/**
 * Atomic chunk-status transition. Mirrors transitionJob but operates on the
 * job's independent chunk_status column.
 */
export async function transitionChunk(
  db: D1Database,
  jobId: string,
  from: ChunkStatus,
  to: ChunkStatus,
  extra?: Record<string, string | number | null>
): Promise<boolean> {
  if (!canTransitionChunk(from, to)) return false;
  const now = new Date().toISOString();
  const sets = ["chunk_status = ?", "updated_at = ?"];
  const vals: unknown[] = [to, now];
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
  }
  vals.push(jobId, from);
  const res = await db
    .prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ? AND chunk_status = ?`)
    .bind(...vals)
    .run();
  return res.meta.changes > 0;
}

/**
 * Atomic optimize-status transition. Mirrors transitionChunk but operates on the
 * job's independent optimize_status column.
 */
export async function transitionOptimize(
  db: D1Database,
  jobId: string,
  from: OptimizeStatus,
  to: OptimizeStatus,
  extra?: Record<string, string | number | null>
): Promise<boolean> {
  if (!canTransitionOptimize(from, to)) return false;
  const now = new Date().toISOString();
  const sets = ["optimize_status = ?", "updated_at = ?"];
  const vals: unknown[] = [to, now];
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
  }
  vals.push(jobId, from);
  const res = await db
    .prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ? AND optimize_status = ?`)
    .bind(...vals)
    .run();
  return res.meta.changes > 0;
}

/** Insert a chunk row whose mp4 bytes were already written to R2 directly. */
export async function insertChunk(
  db: D1Database,
  input: {
    id: string;
    job_id: string;
    chunk_number: number;
    start_sec: number;
    end_sec: number;
    duration: number;
    r2_key: string;
    file_size: number;
    width: number | null;
    height: number | null;
    source_fps: number | null;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO chunks (id, job_id, chunk_number, start_sec, end_sec, duration,
        r2_key, file_size, width, height, source_fps, deleted, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    )
    .bind(
      input.id,
      input.job_id,
      input.chunk_number,
      input.start_sec,
      input.end_sec,
      input.duration,
      input.r2_key,
      input.file_size,
      input.width,
      input.height,
      input.source_fps,
      new Date().toISOString()
    )
    .run();
}

/** Permanently remove a job's chunk rows (used when re-splitting). */
export async function deleteChunkRows(db: D1Database, jobId: string): Promise<void> {
  await db.prepare("DELETE FROM chunks WHERE job_id = ?").bind(jobId).run();
}

/** Permanently remove a job's chunk export rows (used when re-splitting). */
export async function deleteChunkExports(db: D1Database, jobId: string): Promise<void> {
  await db.prepare("DELETE FROM exports WHERE job_id = ? AND kind = 'chunks'").bind(jobId).run();
}
