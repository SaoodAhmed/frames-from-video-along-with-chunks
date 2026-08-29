import { Hono } from "hono";
import type { Env } from "../env";
import { S3_REGION } from "../env";
import { getR2Host, presignGet } from "../lib/s3";
import {
  getJob,
  transitionJob,
  transitionChunk,
  transitionOptimize,
  insertChunk,
  listChunkKeys,
} from "../db/jobs";
import { getOptBatch, listFramesByIds, transitionOptBatch, updateOptBatchProgress } from "../db/opt";
import { r2Keys, userSegmentFromKey, folderSegmentFromKey, IMAGE_EXT } from "../lib/r2";
import type { ImageFormat } from "../lib/r2";
import type { Job, ExportKind, Frame, OptBatch } from "../types";

/**
 * Processor API — consumed by the frame-extraction runner (currently a local
 * Python/OpenCV process; the serverless Modal processor uses the same routes).
 *
 * The runner has no direct R2 or D1 access: the Worker holds the bindings and
 * proxies object reads/writes + state transitions. All routes require the
 * PROCESSOR_TOKEN secret as `Authorization: Bearer <token>`.
 */
const processor = new Hono<{ Bindings: Env }>();

function authorize(c: { req: { header: (n: string) => string | undefined }; env: Env }): boolean {
  const token = c.env.PROCESSOR_TOKEN;
  if (!token) return false;
  const supplied = c.req.header("authorization") || "";
  return supplied === `Bearer ${token}`;
}

const FRAME_FIELDS = `id, job_id, frame_number, source_frame_number, timestamp, r2_key, width, height, deleted, created_at`;

// GET /queue — ids of jobs waiting to be processed
processor.get("/queue", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const rows = await c.env.DB.prepare("SELECT id FROM jobs WHERE status = 'queued'").all<{ id: string }>();
  return c.json({ jobs: (rows.results ?? []).map((r) => r.id) });
});

// GET /video/:jobId — short-lived presigned URL the runner uses to download the source video
processor.get("/video/:jobId", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const job = await getJob(c.env.DB, c.req.param("jobId"));
  if (!job) return c.json({ error: "Not found" }, 404);
  const host = getR2Host(c.env.R2_ENDPOINT, c.env.R2_BUCKET_NAME);
  const url = await presignGet(c.env.R2_ACCESS_KEY_ID, c.env.R2_SECRET_ACCESS_KEY, S3_REGION, host, job.r2_video_key, 900);
  return c.json({ url, r2_video_key: job.r2_video_key });
});

// POST /claim/:jobId — queued -> processing (guarded), returns the full job row
processor.post("/claim/:jobId", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const jobId = c.req.param("jobId");
  const ok = await transitionJob(c.env.DB, jobId, "queued", "processing");
  if (!ok) return c.json({ error: "Job not claimable" }, 409);
  const job = await getJob(c.env.DB, jobId);
  return c.json({ job });
});

// PUT /frame/:jobId/:frameNumber — upload the full-size JPEG; worker writes it to
// R2 and inserts the frames row. Metadata (source frame, timestamp, size) in query.
processor.put("/frame/:jobId/:frameNumber", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const jobId = c.req.param("jobId");
  const frameNumber = parseInt(c.req.param("frameNumber"), 10);
  if (!Number.isInteger(frameNumber) || frameNumber < 1) return c.json({ error: "Invalid frame number" }, 400);

  const src = parseInt(c.req.query("src") || "0", 10) || 0;
  const t = parseFloat(c.req.query("t") || "0") || 0;
  const w = parseInt(c.req.query("w") || "0", 10) || 0;
  const h = parseInt(c.req.query("h") || "0", 10) || 0;

  const job = await getJob(c.env.DB, jobId);
  if (!job) return c.json({ error: "Not found" }, 404);
  if (job.status !== "processing") return c.json({ error: "Job is not processing" }, 409);

  const body = c.req.raw.body;
  if (!body) return c.json({ error: "Empty body" }, 400);

  const fullKey = `users/${userSegmentFromKey(job.r2_video_key)}/${folderSegmentFromKey(job.r2_video_key)}/jobs/${jobId}/frames/full/frame_${String(frameNumber).padStart(4, "0")}.jpg`;
  try {
    await c.env.R2.put(fullKey, body, { httpMetadata: { contentType: "image/jpeg" } });
  } catch (err) {
    console.error("frame upload failed", err);
    return c.json({ error: "Failed to store frame" }, 500);
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO frames (id, job_id, frame_number, source_frame_number, timestamp, r2_key, width, height, deleted, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  )
    .bind(id, jobId, frameNumber, src, t, fullKey, w, h, new Date().toISOString())
    .run();

  return c.json({ ok: true, frameNumber, id });
});

// PUT /frame/:jobId/:frameNumber/thumb — upload the thumbnail JPEG
processor.put("/frame/:jobId/:frameNumber/thumb", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const jobId = c.req.param("jobId");
  const frameNumber = parseInt(c.req.param("frameNumber"), 10);
  if (!Number.isInteger(frameNumber) || frameNumber < 1) return c.json({ error: "Invalid frame number" }, 400);

  const job = await getJob(c.env.DB, jobId);
  if (!job) return c.json({ error: "Not found" }, 404);

  const body = c.req.raw.body;
  if (!body) return c.json({ error: "Empty body" }, 400);

  const fullKey = `users/${userSegmentFromKey(job.r2_video_key)}/${folderSegmentFromKey(job.r2_video_key)}/jobs/${jobId}/frames/full/frame_${String(frameNumber).padStart(4, "0")}.jpg`;
  const thumbKey = fullKey.replace("/frames/full/", "/frames/thumbs/");
  try {
    await c.env.R2.put(thumbKey, body, { httpMetadata: { contentType: "image/jpeg" } });
  } catch (err) {
    console.error("thumb upload failed", err);
    return c.json({ error: "Failed to store thumbnail" }, 500);
  }
  return c.json({ ok: true, frameNumber });
});

// POST /frame/:jobId/:frameNumber/meta — register a frame whose JPEG bytes were
// already written to R2 directly by the runner (boto3). Only the D1 row is
// inserted here; the r2_key is derived from the job row so the runner can't
// influence storage locations.
processor.post("/frame/:jobId/:frameNumber/meta", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const jobId = c.req.param("jobId");
  const frameNumber = parseInt(c.req.param("frameNumber"), 10);
  if (!Number.isInteger(frameNumber) || frameNumber < 1) return c.json({ error: "Invalid frame number" }, 400);

  const src = parseInt(c.req.query("src") || "0", 10) || 0;
  const t = parseFloat(c.req.query("t") || "0") || 0;
  const w = parseInt(c.req.query("w") || "0", 10) || 0;
  const h = parseInt(c.req.query("h") || "0", 10) || 0;

  const job = await getJob(c.env.DB, jobId);
  if (!job) return c.json({ error: "Not found" }, 404);
  if (job.status !== "processing") return c.json({ error: "Job is not processing" }, 409);

  const fullKey = `users/${userSegmentFromKey(job.r2_video_key)}/${folderSegmentFromKey(job.r2_video_key)}/jobs/${jobId}/frames/full/frame_${String(frameNumber).padStart(4, "0")}.jpg`;
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO frames (id, job_id, frame_number, source_frame_number, timestamp, r2_key, width, height, deleted, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  )
    .bind(id, jobId, frameNumber, src, t, fullKey, w, h, new Date().toISOString())
    .run();

  return c.json({ ok: true, frameNumber, id });
});

// POST /progress/:jobId — throttled progress update while processing
processor.post("/progress/:jobId", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const jobId = c.req.param("jobId");
  let body: { processed?: number; total?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const processed = Number(body.processed) || 0;
  const total = Number(body.total) || 0;
  await c.env.DB.prepare(
    "UPDATE jobs SET processed_frames = ?, total_source_frames = ?, updated_at = ? WHERE id = ? AND status = 'processing'"
  )
    .bind(processed, total, new Date().toISOString(), jobId)
    .run();
  return c.json({ ok: true });
});

// POST /complete/:jobId — processing -> completed with extraction metadata
processor.post("/complete/:jobId", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const jobId = c.req.param("jobId");
  let body: {
    srcFps?: number;
    total?: number;
    width?: number;
    height?: number;
    duration?: number;
    extracted?: number;
    videoThumbKey?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const ok = await transitionJob(c.env.DB, jobId, "processing", "completed", {
    extracted_frames: Number(body.extracted) || 0,
    source_fps: Number(body.srcFps) || null,
    total_source_frames: Number(body.total) || null,
    width: Number(body.width) || null,
    height: Number(body.height) || null,
    duration: Number(body.duration) || null,
    video_thumb_key: typeof body.videoThumbKey === "string" ? body.videoThumbKey : null,
    error_message: null,
  });
  if (!ok) return c.json({ error: "Job not completable" }, 409);
  return c.json({ ok: true });
});

// POST /fail/:jobId — mark a queued/processing job as failed with a message
processor.post("/fail/:jobId", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const jobId = c.req.param("jobId");
  let body: { message?: string };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const message = typeof body.message === "string" ? body.message.slice(0, 2000) : "processing failed";
  await c.env.DB.prepare(
    "UPDATE jobs SET status = 'failed', updated_at = ?, error_message = ? WHERE id = ? AND status IN ('processing','queued')"
  )
    .bind(new Date().toISOString(), message, jobId)
    .run();
  return c.json({ ok: true });
});

// ── Chunk splitting (scene-change based) ────────────────────────────────────

// GET /queue/chunks — ids of jobs waiting for scene-based chunk splitting
processor.get("/queue/chunks", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const rows = await c.env.DB
    .prepare("SELECT id FROM jobs WHERE chunk_status = 'queued'")
    .all<{ id: string }>();
  return c.json({ jobs: (rows.results ?? []).map((r) => r.id) });
});

// POST /chunk/claim/:jobId — chunk_status queued -> processing (guarded)
processor.post("/chunk/claim/:jobId", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const jobId = c.req.param("jobId");
  const ok = await transitionChunk(c.env.DB, jobId, "queued", "processing");
  if (!ok) return c.json({ error: "Chunk job not claimable" }, 409);
  const job = await getJob(c.env.DB, jobId);
  return c.json({ job });
});

// POST /chunk/:jobId/:chunkNumber/meta — register a chunk whose mp4 bytes were
// already written to R2 directly by the runner (boto3). Only the D1 row is
// inserted; r2_key is derived from the job row.
processor.post("/chunk/:jobId/:chunkNumber/meta", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const jobId = c.req.param("jobId");
  const chunkNumber = parseInt(c.req.param("chunkNumber"), 10);
  if (!Number.isInteger(chunkNumber) || chunkNumber < 1) return c.json({ error: "Invalid chunk number" }, 400);

  const start = parseFloat(c.req.query("start") || "0") || 0;
  const end = parseFloat(c.req.query("end") || "0") || 0;
  const duration = parseFloat(c.req.query("duration") || "0") || 0;
  const fileSize = parseInt(c.req.query("size") || "0", 10) || 0;
  const w = parseInt(c.req.query("w") || "0", 10) || null;
  const h = parseInt(c.req.query("h") || "0", 10) || null;
  const srcFps = parseFloat(c.req.query("fps") || "0") || null;

  const job = await getJob(c.env.DB, jobId);
  if (!job) return c.json({ error: "Not found" }, 404);
  if (job.chunk_status !== "processing") return c.json({ error: "Chunks are not processing" }, 409);

  const r2Key = r2Keys.chunkVideo(userSegmentFromKey(job.r2_video_key), folderSegmentFromKey(job.r2_video_key), jobId, chunkNumber);
  await insertChunk(c.env.DB, {
    id: crypto.randomUUID(),
    job_id: jobId,
    chunk_number: chunkNumber,
    start_sec: start,
    end_sec: end,
    duration,
    r2_key: r2Key,
    file_size: fileSize,
    width: w,
    height: h,
    source_fps: srcFps,
  });
  return c.json({ ok: true, chunkNumber, r2_key: r2Key });
});

// POST /chunk/progress/:jobId — throttled progress while splitting
processor.post("/chunk/progress/:jobId", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const jobId = c.req.param("jobId");
  let body: { processed?: number; total?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  await c.env.DB.prepare(
    "UPDATE jobs SET chunk_processed = ?, chunk_total = ?, updated_at = ? WHERE id = ? AND chunk_status = 'processing'"
  )
    .bind(Number(body.processed) || 0, Number(body.total) || 0, new Date().toISOString(), jobId)
    .run();
  return c.json({ ok: true });
});

// POST /chunk/complete/:jobId — chunk_status processing -> completed
processor.post("/chunk/complete/:jobId", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const jobId = c.req.param("jobId");
  let body: { count?: number; duration?: number; width?: number; height?: number; srcFps?: number };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const count = Number(body.count) || 0;
  const ok = await transitionChunk(c.env.DB, jobId, "processing", "completed", {
    chunk_count: count,
    chunk_error: null,
  });
  if (!ok) return c.json({ error: "Chunks not completable" }, 409);
  // Fill in video metadata on the job if it was not already captured.
  const job = await getJob(c.env.DB, jobId);
  const updates: Record<string, string | number | null> = { updated_at: new Date().toISOString() };
  if (!job?.duration) updates.duration = Number(body.duration) || null;
  if (!job?.width) updates.width = Number(body.width) || null;
  if (!job?.height) updates.height = Number(body.height) || null;
  if (!job?.source_fps) updates.source_fps = Number(body.srcFps) || null;
  if (job && Object.keys(updates).length > 1) {
    const sets = Object.keys(updates).map((k) => `${k} = ?`).join(", ");
    await c.env.DB.prepare(`UPDATE jobs SET ${sets} WHERE id = ?`)
      .bind(...Object.values(updates), jobId)
      .run();
  }
  return c.json({ ok: true });
});

// POST /chunk/fail/:jobId — mark chunk splitting as failed with a message
processor.post("/chunk/fail/:jobId", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const jobId = c.req.param("jobId");
  let body: { message?: string };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const message = typeof body.message === "string" ? body.message.slice(0, 2000) : "chunk split failed";
  await c.env.DB.prepare(
    "UPDATE jobs SET chunk_status = 'failed', chunk_error = ?, updated_at = ? WHERE id = ? AND chunk_status IN ('processing','queued')"
  )
    .bind(message, new Date().toISOString(), jobId)
    .run();
  return c.json({ ok: true });
});

// ── Optimization (H.264 video compress / image WebP-JPEG) ───────────────────

// GET /queue/optimize — ids of jobs waiting to be optimized
processor.get("/queue/optimize", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const rows = await c.env.DB
    .prepare("SELECT id FROM jobs WHERE optimize_status = 'queued'")
    .all<{ id: string }>();
  return c.json({ jobs: (rows.results ?? []).map((r) => r.id) });
});

// POST /optimize/claim/:jobId — optimize_status queued -> processing (guarded)
processor.post("/optimize/claim/:jobId", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const jobId = c.req.param("jobId");
  const ok = await transitionOptimize(c.env.DB, jobId, "queued", "processing");
  if (!ok) return c.json({ error: "Optimize job not claimable" }, 409);
  const job = await getJob(c.env.DB, jobId);
  return c.json({ job });
});

// POST /optimize/:jobId/meta — heartbeat + output metadata. Refreshes
// updated_at (the stale-claim signal) and stores size/duration when provided.
// Returns 409 when optimize_status is not 'processing' — this is the abort
// mechanism for /cancel: the runner stops and does not call complete/fail.
processor.post("/optimize/:jobId/meta", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const jobId = c.req.param("jobId");
  let body: { size?: number; duration?: number };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const res = await c.env.DB.prepare(
    "UPDATE jobs SET optimized_size = COALESCE(?, optimized_size), optimized_duration = COALESCE(?, optimized_duration), updated_at = ? WHERE id = ? AND optimize_status = 'processing'"
  )
    .bind(
      typeof body.size === "number" ? body.size : null,
      typeof body.duration === "number" ? body.duration : null,
      new Date().toISOString(),
      jobId
    )
    .run();
  if (res.meta.changes === 0) return c.json({ error: "Optimization was cancelled" }, 409);
  return c.json({ ok: true });
});

// POST /optimize/complete/:jobId — optimize_status processing -> completed
processor.post("/optimize/complete/:jobId", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const jobId = c.req.param("jobId");
  let body: { size?: number; duration?: number; format?: string };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const ok = await transitionOptimize(c.env.DB, jobId, "processing", "completed", {
    optimized_size: typeof body.size === "number" ? body.size : null,
    optimized_duration: typeof body.duration === "number" ? body.duration : null,
    opt_format: typeof body.format === "string" ? body.format : null,
    error_message: null,
  });
  if (!ok) return c.json({ error: "Optimization not completable" }, 409);
  return c.json({ ok: true });
});

// POST /optimize/fail/:jobId — mark optimization as failed with a message
processor.post("/optimize/fail/:jobId", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const jobId = c.req.param("jobId");
  let body: { message?: string };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const message = typeof body.message === "string" ? body.message.slice(0, 2000) : "optimization failed";
  await c.env.DB.prepare(
    "UPDATE jobs SET optimize_status = 'failed', error_message = ?, updated_at = ? WHERE id = ? AND optimize_status IN ('processing','queued')"
  )
    .bind(message, new Date().toISOString(), jobId)
    .run();
  return c.json({ ok: true });
});

// ── Frame-image optimization (opt_batches) ──────────────────────────────────

// GET /queue/frameopts — ids of opt_batches waiting to be optimized
processor.get("/queue/frameopts", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const rows = await c.env.DB.prepare("SELECT id FROM opt_batches WHERE status = 'queued'").all<{ id: string }>();
  return c.json({ batches: (rows.results ?? []).map((r) => r.id) });
});

// POST /frameopt/claim/:batchId — opt_batches queued -> processing (guarded).
// Returns the batch, its job (runner derives the user segment from r2_video_key),
// and the ordered frames the runner must re-encode.
processor.post("/frameopt/claim/:batchId", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const batchId = c.req.param("batchId");
  const ok = await transitionOptBatch(c.env.DB, batchId, "queued", "processing");
  if (!ok) return c.json({ error: "Batch not claimable" }, 409);
  const batch = await getOptBatch(c.env.DB, batchId);
  if (!batch) return c.json({ error: "Batch not found" }, 404);
  const job = await getJob(c.env.DB, batch.job_id);
  if (!job) return c.json({ error: "Job not found" }, 404);
  const frameIds = JSON.parse(batch.frame_ids) as string[];
  const frames = await listFramesByIds(c.env.DB, job.id, frameIds);
  return c.json({ batch, job, frames });
});

// GET /frameopt/:batchId/source/:frameNumber — presigned GET (900s) of the
// source frame's R2 object, streamed one-at-a-time so arbitrarily large batches
// never exhaust memory.
processor.get("/frameopt/:batchId/source/:frameNumber", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const batchId = c.req.param("batchId");
  const frameNumber = parseInt(c.req.param("frameNumber"), 10);
  if (!Number.isInteger(frameNumber) || frameNumber < 1) return c.json({ error: "Invalid frame number" }, 400);
  const batch = await getOptBatch(c.env.DB, batchId);
  if (!batch) return c.json({ error: "Batch not found" }, 404);
  const row = await c.env.DB.prepare(
    "SELECT r2_key, width, height FROM frames WHERE job_id = ? AND frame_number = ? AND deleted = 0"
  )
    .bind(batch.job_id, frameNumber)
    .first<{ r2_key: string; width: number; height: number }>();
  if (!row) return c.json({ error: "Frame not found" }, 404);
  const host = getR2Host(c.env.R2_ENDPOINT, c.env.R2_BUCKET_NAME);
  const url = await presignGet(c.env.R2_ACCESS_KEY_ID, c.env.R2_SECRET_ACCESS_KEY, S3_REGION, host, row.r2_key, 900);
  return c.json({ url, frameNumber, width: row.width, height: row.height });
});

// POST /frameopt/:batchId/meta — heartbeat + processed counter. Returns 409 when
// the batch is no longer 'processing' (cancelled) — the abort mechanism.
processor.post("/frameopt/:batchId/meta", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const batchId = c.req.param("batchId");
  let body: { processed?: number };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const ok = await updateOptBatchProgress(c.env.DB, batchId, Number(body.processed) || 0);
  if (!ok) return c.json({ error: "Batch was cancelled" }, 409);
  return c.json({ ok: true });
});

// POST /frameopt/complete/:batchId — opt_batches processing -> completed
processor.post("/frameopt/complete/:batchId", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const batchId = c.req.param("batchId");
  const ok = await transitionOptBatch(c.env.DB, batchId, "processing", "completed");
  if (!ok) return c.json({ error: "Batch not completable" }, 409);
  return c.json({ ok: true });
});

// POST /frameopt/fail/:batchId — mark an opt_batch as failed with a message
processor.post("/frameopt/fail/:batchId", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const batchId = c.req.param("batchId");
  let body: { message?: string };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const message = typeof body.message === "string" ? body.message.slice(0, 2000) : "frame optimization failed";
  await c.env.DB.prepare(
    "UPDATE opt_batches SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ? AND status IN ('processing','queued')"
  )
    .bind(message, new Date().toISOString(), batchId)
    .run();
  return c.json({ ok: true });
});

// ── Exports (ZIP built by the runner) ───────────────────────────────────────

// GET /exports/queue — ids of export rows waiting to be zipped
processor.get("/exports/queue", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const rows = await c.env.DB.prepare("SELECT id FROM exports WHERE status = 'queued'").all<{ id: string }>();
  return c.json({ exports: (rows.results ?? []).map((r) => r.id) });
});

// POST /exports/:exportId/claim — exports queued -> processing (guarded)
processor.post("/exports/:exportId/claim", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const exportId = c.req.param("exportId");
  const res = await c.env.DB.prepare(
    "UPDATE exports SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'queued'"
  )
    .bind(new Date().toISOString(), exportId)
    .run();
  if (res.meta.changes === 0) return c.json({ error: "Export not claimable" }, 409);
  return c.json({ ok: true });
});

// GET /exports/:exportId — export row + the exact R2 objects to bundle (r2_key
// + zip-internal name), plus the target exportKey for the finished zip.
processor.get("/exports/:exportId", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const exportId = c.req.param("exportId");
  const exp = await c.env.DB.prepare("SELECT * FROM exports WHERE id = ?").bind(exportId).first<{
    id: string;
    job_id: string;
    export_type: string;
    kind: ExportKind;
    status: string;
    frame_ids: string | null;
    chunk_ids: string | null;
    batch_id: string | null;
  }>();
  if (!exp) return c.json({ error: "Not found" }, 404);

  const job = await getJob(c.env.DB, exp.job_id);
  if (!job) return c.json({ error: "Job not found" }, 404);

  const kind = exp.kind === "chunks" ? "chunks" : exp.kind === "frames_opt" ? "frames_opt" : exp.kind === "folder" ? "folder" : "frames";
  const seg = userSegmentFromKey(job.r2_video_key);
  const folder = folderSegmentFromKey(job.r2_video_key);
  let items: { key: string; name: string }[] = [];

  if (kind === "folder") {
    // Bundle every job's original + optimized file in this folder. job_id points
    // at the folder's first job (FK NOT NULL); seg/folder come from its key.
    const folderJobs = await c.env.DB
      .prepare(
        `SELECT original_filename, r2_video_key, optimized_key, optimize_status FROM jobs
         WHERE user_id = ? AND COALESCE(folder_id, '') = ? ORDER BY original_filename`
      )
      .bind(job.user_id, folder)
      .all<{ original_filename: string; r2_video_key: string; optimized_key: string | null; optimize_status: string }>();
    items = [];
    for (const fj of folderJobs.results ?? []) {
      items.push({ key: fj.r2_video_key, name: fj.original_filename });
      // Only bundle the optimized output once the runner has actually produced
      // it — queued/processing optimizations have no object in R2 yet.
      if (fj.optimize_status === "completed" && fj.optimized_key) {
        items.push({ key: fj.optimized_key, name: `optimized_${fj.original_filename}` });
      }
    }
  } else if (kind === "chunks") {
    let keys: { id: string; r2_key: string; chunk_number: number }[];
    if (exp.export_type === "selected" && exp.chunk_ids) {
      const ids = JSON.parse(exp.chunk_ids) as string[];
      if (ids.length) {
        const ph = ids.map(() => "?").join(",");
        const rows = await c.env.DB.prepare(
          `SELECT id, r2_key, chunk_number FROM chunks WHERE job_id = ? AND deleted = 0 AND id IN (${ph}) ORDER BY chunk_number ASC`
        ).bind(job.id, ...ids).all<{ id: string; r2_key: string; chunk_number: number }>();
        keys = rows.results ?? [];
      } else keys = [];
    } else {
      keys = await listChunkKeys(c.env.DB, job.id);
    }
    items = keys.map((k) => ({ key: k.r2_key, name: `chunk_${String(k.chunk_number).padStart(4, "0")}.mp4` }));
  } else if (kind === "frames_opt") {
    // Optimized-frame export: bundle the re-encoded keys of the referenced opt_batch.
    const batch = exp.batch_id ? await getOptBatch(c.env.DB, exp.batch_id) : null;
    if (!batch) return c.json({ error: "opt_batch not found" }, 404);
    const frameIds = JSON.parse(batch.frame_ids) as string[];
    const frames = await listFramesByIds(c.env.DB, job.id, frameIds);
    const fmt = batch.format as ImageFormat;
    const ext = IMAGE_EXT[fmt];
    items = frames.map((f) => ({
      key: r2Keys.optimizedFrame(seg, folder, job.id, fmt, f.frame_number),
      name: `frame_${String(f.frame_number).padStart(4, "0")}.${ext}`,
    }));
  } else {
    const includeDeleted = "";
    const whereDeleted = "deleted = 0";
    let rows: Frame[];
    if (exp.export_type === "selected" && exp.frame_ids) {
      const ids = JSON.parse(exp.frame_ids) as string[];
      if (ids.length) {
        const ph = ids.map(() => "?").join(",");
        const res = await c.env.DB.prepare(
          `SELECT ${FRAME_FIELDS} FROM frames WHERE job_id = ? AND deleted = 0 AND id IN (${ph}) ORDER BY frame_number ASC`
        ).bind(job.id, ...ids).all<Frame>();
        rows = res.results ?? [];
      } else rows = [];
    } else {
      const res = await c.env.DB.prepare(
        `SELECT ${FRAME_FIELDS} FROM frames WHERE job_id = ? ${includeDeleted} AND ${whereDeleted} ORDER BY frame_number ASC`
      ).bind(job.id).all<Frame>();
      rows = res.results ?? [];
    }
    items = rows.map((f) => ({
      key: f.r2_key,
      name: `frame_${String(f.frame_number).padStart(4, "0")}.jpg`,
    }));
  }

  const exportKey =
    exp.export_type === "selected"
      ? r2Keys.exportSelected(seg, folder, job.id, kind)
      : r2Keys.exportAll(seg, folder, job.id, kind);

  return c.json({ exportId: exp.id, job_id: exp.job_id, export_type: exp.export_type, kind, status: exp.status, exportKey, items });
});

// POST /exports/:exportId/complete — zip uploaded to R2 by the runner; record it
processor.post("/exports/:exportId/complete", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const exportId = c.req.param("exportId");
  let body: { r2Key?: string; fileSize?: number; count?: number };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const res = await c.env.DB.prepare(
    `UPDATE exports SET status = 'completed', r2_key = ?, file_size = ?, frame_count = ?,
       completed_at = ?, updated_at = ? WHERE id = ? AND status = 'processing'`
  )
    .bind(
      typeof body.r2Key === "string" ? body.r2Key : null,
      Number(body.fileSize) || null,
      Number(body.count) || null,
      new Date().toISOString(),
      new Date().toISOString(),
      exportId
    )
    .run();
  if (res.meta.changes === 0) return c.json({ error: "Export not completable" }, 409);
  return c.json({ ok: true });
});

// POST /exports/:exportId/fail — mark an export as failed with a message
processor.post("/exports/:exportId/fail", async (c) => {
  if (!authorize(c)) return c.json({ error: "Unauthorized" }, 401);
  const exportId = c.req.param("exportId");
  let body: { message?: string };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const message = typeof body.message === "string" ? body.message.slice(0, 2000) : "export failed";
  await c.env.DB.prepare(
    "UPDATE exports SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ? AND status IN ('processing','queued')"
  )
    .bind(message, new Date().toISOString(), exportId)
    .run();
  return c.json({ ok: true });
});

export default processor;
export { FRAME_FIELDS };
