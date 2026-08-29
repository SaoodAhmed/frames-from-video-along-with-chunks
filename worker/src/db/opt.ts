import type { D1Database } from "@cloudflare/workers-types";
import type { OptBatch, OptBatchStatus, Frame } from "../types";

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
