import { Hono } from "hono";
import type { Env } from "../env";
import { requireAdmin } from "../middleware/auth";
import { listAllJobs, countJobsByStatus, getJob, transitionOptimize } from "../db/jobs";
import { r2Keys, userSegmentFromKey, IMAGE_FORMATS, VIDEO_CONTAINERS } from "../lib/r2";
import type { ImageFormat } from "../lib/r2";
import { deleteJobCompletely } from "../lib/cleanup";
import type { JwtUser } from "../types";
import { notifyProcessors } from "./jobs";

const admin = new Hono<{ Bindings: Env; Variables: { user: JwtUser } }>();

// GET /videos — admin list of all jobs (filterable)
admin.get("/videos", requireAdmin, async (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(c.req.query("perPage") || "20", 10) || 20));
  const status = c.req.query("status") || undefined;
  const search = c.req.query("search") || undefined;

  const { rows, total } = await listAllJobs(c.env.DB, {
    status,
    search,
    limit: perPage,
    offset: (page - 1) * perPage,
  });
  return c.json({ jobs: rows, total, page, perPage });
});

// DELETE /jobs/:id — permanently delete a job, its frames, chunks, opt_batches,
// exports and every R2 object it owns.
admin.delete("/jobs/:id", requireAdmin, async (c) => {
  const jobId = c.req.param("id");
  const ok = await deleteJobCompletely(c.env, jobId);
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true, deleted: jobId });
});

// POST /optimize-batch — bulk-optimize many jobs to any format in one shot.
// Skips jobs that are mid-flight (frames/chunks/optimize queued or processing).
// Mirrors the single-job POST /jobs/:id/optimize transition.
admin.post("/optimize-batch", requireAdmin, async (c) => {
  let body: { jobIds?: unknown; options?: Record<string, unknown> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const jobIds = Array.isArray(body.jobIds) ? body.jobIds.filter((x): x is string => typeof x === "string") : [];
  if (!jobIds.length) return c.json({ error: "jobIds required" }, 400);
  const options = (body.options ?? {}) as Record<string, unknown>;

  const queued: string[] = [];
  const skipped: { id: string; reason: string }[] = [];

  for (const jobId of jobIds) {
    const job = await getJob(c.env.DB, jobId);
    if (!job) {
      skipped.push({ id: jobId, reason: "not found" });
      continue;
    }
    if (job.status === "queued" || job.status === "processing") {
      skipped.push({ id: jobId, reason: `frames ${job.status}` });
      continue;
    }
    if (job.chunk_status === "queued" || job.chunk_status === "processing") {
      skipped.push({ id: jobId, reason: `chunks ${job.chunk_status}` });
      continue;
    }
    if (job.optimize_status === "queued" || job.optimize_status === "processing") {
      skipped.push({ id: jobId, reason: `optimize ${job.optimize_status}` });
      continue;
    }

    const isImage = job.media_type === "image";

    const formatRaw = typeof options.format === "string" ? options.format.toLowerCase() : null;
    const format: ImageFormat | null =
      isImage && formatRaw && (IMAGE_FORMATS as readonly string[]).includes(formatRaw) ? (formatRaw as ImageFormat) : null;
    const quality =
      typeof options.quality === "number" && Number.isFinite(options.quality)
        ? Math.min(100, Math.max(1, Math.round(options.quality)))
        : isImage ? 85 : null;
    const containerRaw = typeof options.container === "string" ? options.container.toLowerCase() : null;
    const container = !isImage && containerRaw && (VIDEO_CONTAINERS as readonly string[]).includes(containerRaw) ? containerRaw : null;
    const codecRaw = typeof options.codec === "string" ? options.codec.toLowerCase() : null;
    const codec = !isImage && codecRaw && ["libx264", "libsvtav1"].includes(codecRaw) ? codecRaw : null;
    const crf =
      typeof options.crf === "number" && Number.isFinite(options.crf)
        ? Math.min(45, Math.max(0, Math.round(options.crf)))
        : 23;
    const maxDim =
      typeof options.maxDim === "number" && Number.isFinite(options.maxDim) && options.maxDim > 0
        ? Math.round(options.maxDim)
        : null;

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
    if (!ok) {
      skipped.push({ id: jobId, reason: "cannot start now" });
      continue;
    }
    queued.push(jobId);
    await notifyProcessors(c, { jobId, action: "optimize" });
  }

  return c.json({ queued, skipped });
});

// GET /stats — job counts by status
admin.get("/stats", requireAdmin, async (c) => {
  const stats = await countJobsByStatus(c.env.DB);
  return c.json({ stats });
});

// GET /exports — list recent exports
admin.get("/exports", requireAdmin, async (c) => {
  const rows = await c.env.DB
    .prepare(
      `SELECT e.id, e.job_id, e.export_type, e.status, e.frame_count, e.error_message,
              e.created_at, e.completed_at, j.original_filename
       FROM exports e LEFT JOIN jobs j ON j.id = e.job_id
       ORDER BY e.created_at DESC LIMIT 100`
    )
    .all();
  return c.json({ exports: rows.results ?? [] });
});

export default admin;
