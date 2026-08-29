import { Hono } from "hono";
import type { Env } from "../env";
import { S3_REGION } from "../env";
import { getR2Host, presignGet } from "../lib/s3";
import { triggerGitHubDispatch } from "../lib/github";
import type { DispatchPayload } from "../lib/github";
import { requireAuth, requireAdmin } from "../middleware/auth";
import {
  getJob,
  getJobForUser,
  transitionJob,
  transitionChunk,
  transitionOptimize,
  listChunks,
  listChunkKeys,
  deleteChunkRows,
  deleteChunkExports,
} from "../db/jobs";
import { insertOptBatch, latestCompletedBatch, listFramesByIds } from "../db/opt";
import { PRESETS } from "../types";
import type { Frame, JwtUser, Chunk, ExportKind } from "../types";
import { r2Keys, userSegmentFromKey } from "../lib/r2";
import type { ImageFormat } from "../lib/r2";
import { deleteJobCompletely } from "../lib/cleanup";

const jobs = new Hono<{ Bindings: Env; Variables: { user: JwtUser } }>();

const FRAME_FIELDS = `id, job_id, frame_number, source_frame_number, timestamp, r2_key, width, height, deleted, created_at`;

function thumbKeyFromFull(fullKey: string): string {
  return fullKey.replace("/frames/full/", "/frames/thumbs/");
}

async function triggerProcessor(
  env: Env,
  payload: DispatchPayload
): Promise<boolean> {
  const url = env.MODAL_PROCESS_URL;
  const token = env.MODAL_TOKEN;
  if (!url || !token) return false; // no trigger configured; processor will poll
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch (err) {
    console.error("triggerProcessor failed", err);
    return false;
  }
}

/**
 * Notify whatever processor is available: the legacy Modal webhook if configured
 * AND the GitHub Actions runner (24/7, no laptop). Both are fire-and-forget.
 */
export async function notifyProcessors(
  c: { env: Env; executionCtx?: { waitUntil: (p: Promise<unknown>) => void } },
  payload: DispatchPayload
): Promise<void> {
  await triggerProcessor(c.env, payload);
  // waitUntil must be called as a method of the ExecutionContext, otherwise
  // Workers throws "Illegal invocation" — bind it before handing it off.
  const exec = c.executionCtx;
  const waitUntil = exec?.waitUntil ? exec.waitUntil.bind(exec) : ((p: Promise<unknown>) => void p);
  await triggerGitHubDispatch(c.env, { waitUntil }, payload);
}

// GET /:id — job details (owner or admin)
jobs.get("/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const job = user.role === "admin" ? await getJob(c.env.DB, c.req.param("id")) : await getJobForUser(c.env.DB, user.sub, c.req.param("id"));
  if (!job) return c.json({ error: "Not found" }, 404);

  const host = getR2Host(c.env.R2_ENDPOINT, c.env.R2_BUCKET_NAME);
  const videoUrl = await presignGet(c.env.R2_ACCESS_KEY_ID, c.env.R2_SECRET_ACCESS_KEY, S3_REGION, host, job.r2_video_key, 900);
  const optimizedUrl =
    job.optimize_status === "completed" && job.optimized_key
      ? await presignGet(c.env.R2_ACCESS_KEY_ID, c.env.R2_SECRET_ACCESS_KEY, S3_REGION, host, job.optimized_key, 900)
      : null;
  const thumbUrl =
    job.optimize_status === "completed" && job.optimized_thumb_key
      ? await presignGet(c.env.R2_ACCESS_KEY_ID, c.env.R2_SECRET_ACCESS_KEY, S3_REGION, host, job.optimized_thumb_key, 900)
      : null;
  const videoThumbUrl = job.video_thumb_key
    ? await presignGet(c.env.R2_ACCESS_KEY_ID, c.env.R2_SECRET_ACCESS_KEY, S3_REGION, host, job.video_thumb_key, 900)
    : null;
  return c.json({ job, videoUrl, optimizedUrl, thumbUrl, videoThumbUrl });
});

// DELETE /:id — owner or admin permanently deletes the job and its R2 objects
jobs.delete("/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const jobId = c.req.param("id");
  const job = user.role === "admin" ? await getJob(c.env.DB, jobId) : await getJobForUser(c.env.DB, user.sub, jobId);
  if (!job) return c.json({ error: "Not found" }, 404);
  await deleteJobCompletely(c.env, jobId);
  return c.json({ ok: true, deleted: jobId });
});

// POST /:id/process — admin starts processing (uploaded/failed/cancelled -> queued)
jobs.post("/:id/process", requireAdmin, async (c) => {
  const jobId = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const job = await getJob(c.env.DB, jobId);
  if (!job) return c.json({ error: "Not found" }, 404);
  if (!["uploaded", "failed", "cancelled"].includes(job.status)) {
    return c.json({ error: `Cannot process a job in status '${job.status}'` }, 409);
  }
  // Mutual exclusion: don't queue frame extraction while a chunk split is active.
  if (job.chunk_status === "queued" || job.chunk_status === "processing") {
    return c.json({ error: `Cannot process frames while chunks are ${job.chunk_status}` }, 409);
  }

  // Resolve extraction mode + fps from the preset name (mirrors desktop app).
  const presetName = typeof body.mode === "string" ? body.mode : "1 fps";
  const preset = PRESETS.find((p) => p.name === presetName);
  if (!preset) return c.json({ error: "Unknown extraction preset" }, 400);

  let extractionFps: number | null;
  switch (preset.mode) {
    case "every_frame":
      extractionFps = -2; // sentinel: source fps
      break;
    case "smart_scene":
      extractionFps = -1; // sentinel: scene detection
      break;
    case "one_per_5s":
      extractionFps = 0.2;
      break;
    case "thumb_strip":
      extractionFps = 0; // sentinel: auto
      break;
    case "custom": {
      const v = typeof body.fps === "number" ? body.fps : NaN;
      if (!Number.isFinite(v) || v <= 0 || v > 120) {
        return c.json({ error: "Custom FPS must be between 0.1 and 120" }, 400);
      }
      extractionFps = v;
      break;
    }
    default:
      extractionFps = preset.fps ?? 1.0;
  }

  const sharpness = typeof body.sharpness === "number" ? body.sharpness : 1.0;
  const sceneThreshold = typeof body.sceneThreshold === "number" ? body.sceneThreshold : 30.0;
  if (sharpness < 0.5 || sharpness > 3.0) {
    return c.json({ error: "Sharpness must be between 0.5 and 3.0" }, 400);
  }

  const ok = await transitionJob(c.env.DB, jobId, job.status, "queued", {
    extraction_mode: preset.mode,
    extraction_fps: extractionFps,
    sharpness,
    scene_threshold: sceneThreshold,
    error_message: null,
  });
  if (!ok) return c.json({ error: "Job state changed concurrently" }, 409);

  const updated = await getJob(c.env.DB, jobId);
  await notifyProcessors(c, { jobId, action: "process" });
  return c.json({ job: updated });
});

// POST /:id/cancel — admin cancels active frame processing (job.status) OR
// active chunk splitting (chunk_status) OR active optimization (optimize_status).
jobs.post("/:id/cancel", requireAdmin, async (c) => {
  const jobId = c.req.param("id");
  const job = await getJob(c.env.DB, jobId);
  if (!job) return c.json({ error: "Not found" }, 404);

  let ok = await transitionJob(c.env.DB, jobId, "queued", "cancelled");
  if (!ok) ok = await transitionJob(c.env.DB, jobId, "processing", "cancelled");
  if (!ok) {
    ok = await transitionChunk(c.env.DB, jobId, "queued", "cancelled");
    if (!ok) ok = await transitionChunk(c.env.DB, jobId, "processing", "cancelled");
  }
  if (!ok) {
    ok = await transitionOptimize(c.env.DB, jobId, "queued", "cancelled");
    if (!ok) ok = await transitionOptimize(c.env.DB, jobId, "processing", "cancelled");
  }
  if (!ok) {
    return c.json({ error: `Cannot cancel job (status '${job.status}', chunks '${job.chunk_status}', optimize '${job.optimize_status}')` }, 409);
  }
  return c.json({ ok: true, job: await getJob(c.env.DB, jobId) });
});

// POST /:id/retry — admin retries a failed/cancelled job
jobs.post("/:id/retry", requireAdmin, async (c) => {
  const jobId = c.req.param("id");
  const job = await getJob(c.env.DB, jobId);
  if (!job) return c.json({ error: "Not found" }, 404);

  const ok = await transitionJob(c.env.DB, jobId, job.status, "queued", {
    error_message: null,
  });
  if (!ok) return c.json({ error: `Cannot retry a job in status '${job.status}'` }, 409);

  const updated = await getJob(c.env.DB, jobId);
  await notifyProcessors(c, { jobId, action: "process" });
  return c.json({ job: updated });
});

// GET /:id/frames — admin paginated frame list with presigned URLs
jobs.get("/:id/frames", requireAdmin, async (c) => {
  const jobId = c.req.param("id");
  const job = await getJob(c.env.DB, jobId);
  if (!job) return c.json({ error: "Not found" }, 404);

  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(c.req.query("perPage") || "50", 10) || 50));
  const includeDeleted = c.req.query("includeDeleted") === "true";

  const whereDeleted = includeDeleted ? "" : "AND deleted = 0";
  const count = await c.env.DB
    .prepare(`SELECT COUNT(*) AS n FROM frames WHERE job_id = ? ${whereDeleted}`)
    .bind(jobId)
    .first<{ n: number }>();
  const rows = await c.env.DB
    .prepare(`SELECT ${FRAME_FIELDS} FROM frames WHERE job_id = ? ${whereDeleted} ORDER BY frame_number ASC LIMIT ? OFFSET ?`)
    .bind(jobId, perPage, (page - 1) * perPage)
    .all<Frame>();

  const host = getR2Host(c.env.R2_ENDPOINT, c.env.R2_BUCKET_NAME);
  const seg = userSegmentFromKey(job.r2_video_key);
  // When the latest frame-optimize batch is complete, presign optimized URLs for
  // the frames it covered so the gallery can toggle Original / Optimized.
  const batch = await latestCompletedBatch(c.env.DB, jobId);
  const batchFrameIds = batch ? new Set(JSON.parse(batch.frame_ids) as string[]) : null;
  const batchFormat = batch?.format as ImageFormat | undefined;

  const frames = await Promise.all(
    (rows.results ?? []).map(async (f) => ({
      ...f,
      thumbUrl: f.deleted ? null : await presignGet(c.env.R2_ACCESS_KEY_ID, c.env.R2_SECRET_ACCESS_KEY, S3_REGION, host, thumbKeyFromFull(f.r2_key), 900),
      fullUrl: f.deleted ? null : await presignGet(c.env.R2_ACCESS_KEY_ID, c.env.R2_SECRET_ACCESS_KEY, S3_REGION, host, f.r2_key, 900),
      optimizedUrl: !f.deleted && batch && batchFormat && batchFrameIds?.has(f.id)
        ? await presignGet(c.env.R2_ACCESS_KEY_ID, c.env.R2_SECRET_ACCESS_KEY, S3_REGION, host, r2Keys.optimizedFrame(seg, jobId, batchFormat, f.frame_number), 900)
        : null,
    }))
  );

  return c.json({
    job,
    frames,
    total: count?.n ?? 0,
    page,
    perPage,
    optBatch: batch ? { id: batch.id, format: batch.format, status: batch.status, total: batch.total, processed: batch.processed } : null,
  });
});

// POST /:id/frames/delete — admin deletes selected frames (soft delete + R2 cleanup)
jobs.post("/:id/frames/delete", requireAdmin, async (c) => {
  const jobId = c.req.param("id");
  const job = await getJob(c.env.DB, jobId);
  if (!job) return c.json({ error: "Not found" }, 404);

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const frameIds = Array.isArray(body.frameIds) ? body.frameIds.filter((x): x is string => typeof x === "string") : [];
  if (frameIds.length === 0) return c.json({ error: "frameIds required" }, 400);

  const rows = await c.env.DB
    .prepare(`SELECT ${FRAME_FIELDS} FROM frames WHERE job_id = ? AND id IN (${frameIds.map(() => "?").join(",")}) AND deleted = 0`)
    .bind(jobId, ...frameIds)
    .all<Frame>();

  const framesToDelete = rows.results ?? [];
  const placeholders = frameIds.map(() => "?").join(",");
  await c.env.DB
    .prepare(`UPDATE frames SET deleted = 1 WHERE job_id = ? AND id IN (${placeholders})`)
    .bind(jobId, ...frameIds)
    .run();

  // Remove corresponding R2 objects (no orphaned objects).
  for (const f of framesToDelete) {
    await Promise.allSettled([
      c.env.R2.delete(f.r2_key),
      c.env.R2.delete(thumbKeyFromFull(f.r2_key)),
    ]);
  }

  const remaining = await c.env.DB
    .prepare("SELECT COUNT(*) AS n FROM frames WHERE job_id = ? AND deleted = 0")
    .bind(jobId)
    .first<{ n: number }>();
  await c.env.DB
    .prepare("UPDATE jobs SET extracted_frames = ?, updated_at = ? WHERE id = ?")
    .bind(remaining?.n ?? 0, new Date().toISOString(), jobId)
    .run();

  return c.json({ ok: true, deleted: framesToDelete.length });
});

// POST /:id/frames/optimize — admin selects frame images and converts them to a
// chosen format/quality/maxDim. Creates an opt_batch row the runner drains.
jobs.post("/:id/frames/optimize", requireAdmin, async (c) => {
  const jobId = c.req.param("id");
  const job = await getJob(c.env.DB, jobId);
  if (!job) return c.json({ error: "Not found" }, 404);

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const frameIds = Array.isArray(body.frameIds) ? body.frameIds.filter((x): x is string => typeof x === "string") : [];
  if (frameIds.length === 0) return c.json({ error: "frameIds required" }, 400);

  const formatRaw = typeof body.format === "string" ? body.format.toLowerCase() : "webp";
  const format: ImageFormat = ["webp", "jpeg", "avif", "png"].includes(formatRaw) ? (formatRaw as ImageFormat) : "webp";
  const quality =
    typeof body.quality === "number" && Number.isFinite(body.quality)
      ? Math.min(100, Math.max(1, Math.round(body.quality)))
      : 85;
  const maxDim =
    typeof body.maxDim === "number" && Number.isFinite(body.maxDim) && body.maxDim > 0
      ? Math.round(body.maxDim)
      : null;

  const frames = await listFramesByIds(c.env.DB, jobId, frameIds);
  if (frames.length === 0) return c.json({ error: "No matching frames for this job" }, 400);

  const batchId = crypto.randomUUID();
  await insertOptBatch(c.env.DB, {
    id: batchId,
    job_id: jobId,
    format,
    max_dim: maxDim,
    quality,
    frame_ids: frames.map((f) => f.id),
  });
  await notifyProcessors(c, { jobId, batchId, action: "frameopt" });
  return c.json({ batchId, status: "queued", total: frames.length }, 201);
});

async function createExport(
  c: { env: Env; json: (data: unknown, status?: number) => Response },
  jobId: string,
  kind: ExportKind,
  body: Record<string, unknown>
) {
  const type = body.type === "selected" ? "selected" : "all";
  const raw =
    body.ids ??
    body[`${kind === "chunks" ? "chunkIds" : "frameIds"}`] ??
    body.frameIds ??
    body.chunkIds;
  const ids = Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === "string")
    : [];

  if (type === "selected" && ids.length === 0) {
    return c.json({ error: `${kind === "chunks" ? "chunkIds" : "frameIds"} required for selected export` }, 400);
  }

  const exportId = crypto.randomUUID();
  const now = new Date().toISOString();
  const idCol = kind === "chunks" ? "chunk_ids" : "frame_ids";
  const batchId = kind === "frames_opt" && typeof body.batchId === "string" ? body.batchId : null;
  await c.env.DB.prepare(
    `INSERT INTO exports (id, job_id, export_type, kind, status, ${idCol}, batch_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`
  )
    .bind(exportId, jobId, type, kind, type === "selected" ? JSON.stringify(ids) : null, batchId, now, now)
    .run();

  await notifyProcessors(c, { jobId, action: "export", exportId });
  return c.json({ exportId, status: "queued", kind }, 201);
}

// POST /:id/export — admin creates a ZIP of extracted frames (all or selected)
jobs.post("/:id/export", requireAdmin, async (c) => {
  const jobId = c.req.param("id");
  const job = await getJob(c.env.DB, jobId);
  if (!job) return c.json({ error: "Not found" }, 404);

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  if (body.ids) body.frameIds = body.ids; // accept both spellings
  return createExport(c, jobId, "frames", body);
});

// POST /:id/exports — generic export creator (frames_opt = optimized frames of an opt batch)
jobs.post("/:id/exports", requireAdmin, async (c) => {
  const jobId = c.req.param("id");
  const job = await getJob(c.env.DB, jobId);
  if (!job) return c.json({ error: "Not found" }, 404);

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const kind = body.kind === "frames_opt" ? "frames_opt" : "frames";
  if (kind === "frames_opt" && typeof body.batchId !== "string") {
    return c.json({ error: "batchId required for frames_opt export" }, 400);
  }
  return createExport(c, jobId, kind, body);
});

// ── Chunks ────────────────────────────────────────────────────────────────

// POST /:id/chunk — admin triggers scene-based splitting of the video into chunks
jobs.post("/:id/chunk", requireAdmin, async (c) => {
  const jobId = c.req.param("id");
  const job = await getJob(c.env.DB, jobId);
  if (!job) return c.json({ error: "Not found" }, 404);

  // Chunks-active check first: when a job has frames queued AND chunks running,
  // this is the accurate blocker (and the more actionable message).
  if (job.chunk_status === "queued" || job.chunk_status === "processing") {
    return c.json({ error: `Chunks are already ${job.chunk_status}` }, 409);
  }
  if (["queued", "processing"].includes(job.status)) {
    return c.json({ error: `Cannot split a job in status '${job.status}'` }, 409);
  }

  // Re-splitting replaces the previous chunks entirely.
  const chunks = await listChunkKeys(c.env.DB, jobId);
  for (const ch of chunks) await Promise.allSettled([c.env.R2.delete(ch.r2_key)]);
  await deleteChunkRows(c.env.DB, jobId);
  await deleteChunkExports(c.env.DB, jobId);

  const ok = await transitionChunk(c.env.DB, jobId, job.chunk_status, "queued", {
    chunk_count: 0,
    chunk_processed: 0,
    chunk_total: 0,
    chunk_error: null,
  });
  if (!ok) return c.json({ error: "Cannot start chunking now" }, 409);

  const updated = await getJob(c.env.DB, jobId);
  await notifyProcessors(c, { jobId, action: "chunk" });
  return c.json({ job: updated });
});

// POST /:id/optimize — admin manually optimizes a job to ANY format.
// Video: container (mp4/mkv/webm) x codec (libx264/libsvtav1) x crf x maxDim.
// Image:  format (webp/jpeg/avif/png) x quality x maxDim. Re-running replaces output.
jobs.post("/:id/optimize", requireAdmin, async (c) => {
  const jobId = c.req.param("id");
  const job = await getJob(c.env.DB, jobId);
  if (!job) return c.json({ error: "Not found" }, 404);

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const isImage = job.media_type === "image";

  // Image params
  const formatRaw = typeof body.format === "string" ? body.format.toLowerCase() : null;
  const format: ImageFormat | null =
    isImage && formatRaw && ["webp", "jpeg", "avif", "png"].includes(formatRaw) ? (formatRaw as ImageFormat) : null;
  const quality =
    typeof body.quality === "number" && Number.isFinite(body.quality)
      ? Math.min(100, Math.max(1, Math.round(body.quality)))
      : isImage ? 85 : null;

  // Video params
  const containerRaw = typeof body.container === "string" ? body.container.toLowerCase() : null;
  const container = !isImage && containerRaw && ["mp4", "mkv", "webm"].includes(containerRaw) ? containerRaw : null;
  const codecRaw = typeof body.codec === "string" ? body.codec.toLowerCase() : null;
  const codec = !isImage && codecRaw && ["libx264", "libsvtav1"].includes(codecRaw) ? codecRaw : null;
  const crf =
    typeof body.crf === "number" && Number.isFinite(body.crf)
      ? Math.min(45, Math.max(0, Math.round(body.crf)))
      : 23;
  const maxDim =
    typeof body.maxDim === "number" && Number.isFinite(body.maxDim) && body.maxDim > 0
      ? Math.round(body.maxDim)
      : null;

  if (job.optimize_status === "queued" || job.optimize_status === "processing") {
    return c.json({ error: `Optimization is already ${job.optimize_status}` }, 409);
  }

  // Re-optimizing replaces the previous output entirely.
  for (const key of [job.optimized_key, job.optimized_thumb_key]) {
    if (key) await Promise.allSettled([c.env.R2.delete(key)]);
  }

  const seg = userSegmentFromKey(job.r2_video_key);
  const optContainer = container ?? (codec === "libsvtav1" ? "webm" : "mp4");
  const optFormat = format ?? (isImage ? "webp" : null);
  const optimizedKey = isImage
    ? r2Keys.optimizedImage(seg, jobId, optFormat!)
    : r2Keys.optimizedVideo(seg, jobId, optContainer as "mp4" | "mkv" | "webm");
  const thumbKey = isImage ? r2Keys.thumbImage(seg, jobId) : null;
  const ok = await transitionOptimize(c.env.DB, jobId, job.optimize_status, "queued", {
    opt_crf: isImage ? null : crf,
    opt_max_dim: maxDim,
    opt_quality: isImage ? quality : null,
    opt_codec: isImage ? null : (codec ?? "libx264"),
    opt_container: isImage ? null : optContainer,
    optimized_key: optimizedKey,
    optimized_size: null,
    optimized_duration: null,
    optimized_thumb_key: thumbKey,
    opt_format: optFormat,
    error_message: null,
  });
  if (!ok) return c.json({ error: "Cannot start optimization now" }, 409);

  const updated = await getJob(c.env.DB, jobId);
  await notifyProcessors(c, { jobId, action: "optimize" });
  return c.json({ job: updated });
});

// GET /:id/chunks — admin paginated chunk list with presigned play URLs
jobs.get("/:id/chunks", requireAdmin, async (c) => {
  const jobId = c.req.param("id");
  const job = await getJob(c.env.DB, jobId);
  if (!job) return c.json({ error: "Not found" }, 404);

  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(c.req.query("perPage") || "50", 10) || 50));
  const includeDeleted = c.req.query("includeDeleted") === "true";

  const { rows, total } = await listChunks(c.env.DB, jobId, { page, perPage, includeDeleted });
  const host = getR2Host(c.env.R2_ENDPOINT, c.env.R2_BUCKET_NAME);
  const chunks = await Promise.all(
    rows.map(async (ch: Chunk) => ({
      ...ch,
      playUrl: ch.deleted ? null : await presignGet(c.env.R2_ACCESS_KEY_ID, c.env.R2_SECRET_ACCESS_KEY, S3_REGION, host, ch.r2_key, 900),
    }))
  );

  return c.json({ job, chunks, total, page, perPage });
});

// POST /:id/chunks/delete — admin deletes selected chunks (soft delete + R2 cleanup)
jobs.post("/:id/chunks/delete", requireAdmin, async (c) => {
  const jobId = c.req.param("id");
  const job = await getJob(c.env.DB, jobId);
  if (!job) return c.json({ error: "Not found" }, 404);

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const chunkIds = Array.isArray(body.chunkIds) ? body.chunkIds.filter((x): x is string => typeof x === "string") : [];
  if (chunkIds.length === 0) return c.json({ error: "chunkIds required" }, 400);

  const placeholders = chunkIds.map(() => "?").join(",");
  const rows = await c.env.DB
    .prepare(`SELECT id, r2_key FROM chunks WHERE job_id = ? AND id IN (${placeholders}) AND deleted = 0`)
    .bind(jobId, ...chunkIds)
    .all<{ id: string; r2_key: string }>();

  await c.env.DB
    .prepare(`UPDATE chunks SET deleted = 1 WHERE job_id = ? AND id IN (${placeholders})`)
    .bind(jobId, ...chunkIds)
    .run();

  for (const r of rows.results ?? []) await Promise.allSettled([c.env.R2.delete(r.r2_key)]);

  const remaining = await c.env.DB
    .prepare("SELECT COUNT(*) AS n FROM chunks WHERE job_id = ? AND deleted = 0")
    .bind(jobId)
    .first<{ n: number }>();
  await c.env.DB
    .prepare("UPDATE jobs SET chunk_count = ?, updated_at = ? WHERE id = ?")
    .bind(remaining?.n ?? 0, new Date().toISOString(), jobId)
    .run();

  return c.json({ ok: true, deleted: rows.results?.length ?? 0 });
});

// POST /:id/chunks/export — admin creates a ZIP of chunk videos (all or selected)
jobs.post("/:id/chunks/export", requireAdmin, async (c) => {
  const jobId = c.req.param("id");
  const job = await getJob(c.env.DB, jobId);
  if (!job) return c.json({ error: "Not found" }, 404);

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  return createExport(c, jobId, "chunks", body);
});

// GET /exports/:exportId — export status + presigned download URL when ready
jobs.get("/exports/:exportId", requireAdmin, async (c) => {
  const exportId = c.req.param("exportId");
  const exp = await c.env.DB
    .prepare("SELECT * FROM exports WHERE id = ?")
    .bind(exportId)
    .first<{ id: string; job_id: string; export_type: string; status: string; r2_key: string | null; file_size: number | null; error_message: string | null; frame_count: number | null; created_at: string; completed_at: string | null }>();
  if (!exp) return c.json({ error: "Not found" }, 404);

  let downloadUrl: string | null = null;
  if (exp.status === "completed" && exp.r2_key) {
    const host = getR2Host(c.env.R2_ENDPOINT, c.env.R2_BUCKET_NAME);
    downloadUrl = await presignGet(c.env.R2_ACCESS_KEY_ID, c.env.R2_SECRET_ACCESS_KEY, S3_REGION, host, exp.r2_key, 900);
  }
  return c.json({ ...exp, downloadUrl });
});

export default jobs;
