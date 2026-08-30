import type { D1Database } from "@cloudflare/workers-types";
import type { OptBatch, OptBatchStatus, Frame, Optimization, OptimizationStatus, MediaType } from "../types";

const OPT_BATCH_FIELDS = `id, job_id, format, max_dim, quality, status, total, processed,
  frame_ids, error_message, created_at, updated_at, completed_at`;

export async function insertOptBatch(
  db: D1Database,
  input: {
    id: string;
    job_id: string;
    format: string;
    max_dim: number | null;
    quality: number;
    frame_ids: string[];
  }
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO opt_batches (id, job_id, format, max_dim, quality, status, total, processed,
        frame_ids, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?, ?)`
    )
    .bind(
      input.id,
      input.job_id,
      input.format,
      input.max_dim,
      input.quality,
      input.frame_ids.length,
      JSON.stringify(input.frame_ids),
      now,
      now
    )
    .run();
}

export async function getOptBatch(db: D1Database, batchId: string): Promise<OptBatch | null> {
  const row = await db.prepare(`SELECT ${OPT_BATCH_FIELDS} FROM opt_batches WHERE id = ?`).bind(batchId).first<OptBatch>();
  return row ?? null;
}

/** Latest completed opt_batch for a job (used to show the "optimized" frame view). */
export async function latestCompletedBatch(db: D1Database, jobId: string): Promise<OptBatch | null> {
  const row = await db
    .prepare(`SELECT ${OPT_BATCH_FIELDS} FROM opt_batches WHERE job_id = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 1`)
    .bind(jobId)
    .first<OptBatch>();
  return row ?? null;
}

const OPT_BATCH_TRANSITIONS: Record<OptBatchStatus, OptBatchStatus[]> = {
  queued: ["processing", "failed", "cancelled"],
  processing: ["completed", "failed", "cancelled"],
  completed: ["queued"],
  failed: ["queued"],
  cancelled: ["queued"],
};

export async function transitionOptBatch(
  db: D1Database,
  batchId: string,
  from: OptBatchStatus,
  to: OptBatchStatus,
  extra?: Record<string, string | number | null>
): Promise<boolean> {
  if (!OPT_BATCH_TRANSITIONS[from]?.includes(to)) return false;
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
  vals.push(batchId, from);
  const res = await db
    .prepare(`UPDATE opt_batches SET ${sets.join(", ")} WHERE id = ? AND status = ?`)
    .bind(...vals)
    .run();
  return res.meta.changes > 0;
}

/** Heartbeat + processed counter. Returns 0 rows when the batch is no longer
 * 'processing' (cancelled) — the runner treats that as an abort signal. */
export async function updateOptBatchProgress(
  db: D1Database,
  batchId: string,
  processed: number
): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE opt_batches SET processed = ?, updated_at = ? WHERE id = ? AND status = 'processing'`)
    .bind(processed, new Date().toISOString(), batchId)
    .run();
  return res.meta.changes > 0;
}

// ── Format-specific optimization variants ──────────────────────────────────

const OPT_FIELDS = `id, job_id, media_type, format, codec, crf, quality, max_dim,
  r2_key, size, duration, status, error_message, created_at, updated_at, completed_at`;

interface UpsertOptimizationInput {
  jobId: string;
  mediaType: MediaType;
  format: string;
  codec?: string | null;
  crf?: number | null;
  quality?: number | null;
  maxDim?: number | null;
  r2Key: string;
}

/**
 * Insert or refresh the variant identified by (job_id, media_type, format).
 * Same-format re-optimization upserts (overwrite); a new format is a new row,
 * leaving other formats' variants untouched.
 */
export async function upsertOptimization(db: D1Database, input: UpsertOptimizationInput): Promise<void> {
  const now = new Date().toISOString();
  const existing = await db
    .prepare(`SELECT id FROM optimizations WHERE job_id = ? AND media_type = ? AND format = ?`)
    .bind(input.jobId, input.mediaType, input.format)
    .first<{ id: string }>();
  if (existing) {
    await db
      .prepare(
        `UPDATE optimizations SET codec = ?, crf = ?, quality = ?, max_dim = ?,
           r2_key = ?, size = NULL, duration = NULL, status = 'queued', error_message = NULL,
           updated_at = ? WHERE id = ?`
      )
      .bind(input.codec ?? null, input.crf ?? null, input.quality ?? null, input.maxDim ?? null,
        input.r2Key, now, existing.id)
      .run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO optimizations (id, job_id, media_type, format, codec, crf, quality, max_dim,
         r2_key, size, duration, status, error_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'queued', NULL, ?, ?)`
    )
    .bind(crypto.randomUUID(), input.jobId, input.mediaType, input.format,
      input.codec ?? null, input.crf ?? null, input.quality ?? null, input.maxDim ?? null,
      input.r2Key, now, now)
    .run();
}

/** The variant a job's current optimize run targets (same format as job.opt_format). */
export async function getOptimization(
  db: D1Database,
  jobId: string,
  mediaType: MediaType,
  format: string
): Promise<Optimization | null> {
  const row = await db
    .prepare(`SELECT ${OPT_FIELDS} FROM optimizations WHERE job_id = ? AND media_type = ? AND format = ?`)
    .bind(jobId, mediaType, format)
    .first<Optimization>();
  return row ?? null;
}

export async function getOptimizationById(db: D1Database, id: string): Promise<Optimization | null> {
  const row = await db.prepare(`SELECT ${OPT_FIELDS} FROM optimizations WHERE id = ?`).bind(id).first<Optimization>();
  return row ?? null;
}

/** Mark a variant's status/size after the runner finishes. */
export async function updateOptimizationResult(
  db: D1Database,
  jobId: string,
  mediaType: MediaType,
  format: string,
  status: OptimizationStatus,
  extra?: { size?: number | null; duration?: number | null; error?: string | null }
): Promise<void> {
  const now = new Date().toISOString();
  const sets: string[] = ["status = ?", "updated_at = ?"];
  const vals: unknown[] = [status, now];
  if (extra?.size !== undefined) { sets.push("size = ?"); vals.push(extra.size); }
  if (extra?.duration !== undefined) { sets.push("duration = ?"); vals.push(extra.duration); }
  if (extra?.error !== undefined) { sets.push("error_message = ?"); vals.push(extra.error); }
  if (status === "completed") { sets.push("completed_at = ?"); vals.push(now); }
  vals.push(jobId, mediaType, format);
  await db
    .prepare(`UPDATE optimizations SET ${sets.join(", ")} WHERE job_id = ? AND media_type = ? AND format = ?`)
    .bind(...vals)
    .run();
}

/** Distinct completed variant formats across the whole system, with counts. */
export async function listOptimizationFormats(db: D1Database): Promise<{ format: string; count: number }[]> {
  const rows = await db
    .prepare(`SELECT format, COUNT(*) AS count FROM optimizations WHERE status = 'completed' GROUP BY format ORDER BY format`)
    .all<{ format: string; count: number }>();
  return rows.results ?? [];
}

/** All variants for a job (their R2 keys must be cleaned up with the job). */
export async function listOptimizationsForJob(db: D1Database, jobId: string): Promise<Optimization[]> {
  const rows = await db
    .prepare(`SELECT ${OPT_FIELDS} FROM optimizations WHERE job_id = ? ORDER BY created_at DESC`)
    .bind(jobId)
    .all<Optimization>();
  return rows.results ?? [];
}

export async function deleteOptimizationById(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM optimizations WHERE id = ?").bind(id).run();
}

/** Live frames for a job whose ids are in the given list. */
export async function listFramesByIds(
  db: D1Database,
  jobId: string,
  frameIds: string[]
): Promise<Frame[]> {
  if (frameIds.length === 0) return [];
  const ph = frameIds.map(() => "?").join(",");
  const rows = await db
    .prepare(`SELECT id, job_id, frame_number, source_frame_number, timestamp, r2_key, width, height, deleted, created_at
              FROM frames WHERE job_id = ? AND deleted = 0 AND id IN (${ph}) ORDER BY frame_number ASC`)
    .bind(jobId, ...frameIds)
    .all<Frame>();
  return rows.results ?? [];
}

export { OPT_BATCH_FIELDS };
