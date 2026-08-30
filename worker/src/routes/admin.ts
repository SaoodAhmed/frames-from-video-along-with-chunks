import { Hono } from "hono";
import type { Env } from "../env";
import { S3_REGION } from "../env";
import { getR2Host, presignGet } from "../lib/s3";
import { requireAdmin } from "../middleware/auth";
import { listAllJobs, countJobsByStatus, getJob, transitionOptimize, listUserJobsFiltered } from "../db/jobs";
import {
  upsertOptimization, listOptimizationFormats, getOptimizationById,
  deleteOptimizationById, listFramesByIds,
} from "../db/opt";
import { r2Keys, userSegmentFromKey, folderSegmentFromKey, IMAGE_FORMATS, VIDEO_CONTAINERS } from "../lib/r2";
import type { ImageFormat } from "../lib/r2";
import { deleteJobCompletely } from "../lib/cleanup";
import { getFolder, validateFolderName, collectFolderDescendants, deleteFolderCompletely } from "../db/folders";
import type { JwtUser } from "../types";
import { notifyProcessors } from "./jobs";

const admin = new Hono<{ Bindings: Env; Variables: { user: JwtUser } }>();

// GET /videos — admin list of all jobs (filterable), each enriched with presigned
// original/thumb/optimized URLs so the Media gallery renders directly.
admin.get("/videos", requireAdmin, async (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10) || 1);
  const perPage = Math.min(200, Math.max(1, parseInt(c.req.query("perPage") || "60", 10) || 60));
  const status = c.req.query("status") || undefined;
  const search = c.req.query("search") || undefined;
  const type = c.req.query("type");
  const mediaType = type === "image" ? "image" : type === "video" ? "video" : undefined;

  const { rows, total } = await listAllJobs(c.env.DB, {
    status,
    search,
    mediaType,
    limit: perPage,
    offset: (page - 1) * perPage,
  });

  const host = getR2Host(c.env.R2_ENDPOINT, c.env.R2_BUCKET_NAME);
  const jobs = await Promise.all(
    rows.map(async (j) => {
      const isImage = j.media_type === "image";
      const originalUrl = await presignGet(c.env.R2_ACCESS_KEY_ID, c.env.R2_SECRET_ACCESS_KEY, S3_REGION, host, j.r2_video_key, 3600);
      if (isImage) {
        if (j.optimize_status !== "completed") return { ...j, originalUrl };
        const [thumbUrl, optimizedUrl] = await Promise.all([
          j.optimized_thumb_key
            ? presignGet(c.env.R2_ACCESS_KEY_ID, c.env.R2_SECRET_ACCESS_KEY, S3_REGION, host, j.optimized_thumb_key, 900)
            : null,
          j.optimized_key
            ? presignGet(c.env.R2_ACCESS_KEY_ID, c.env.R2_SECRET_ACCESS_KEY, S3_REGION, host, j.optimized_key, 900)
            : null,
        ]);
        return { ...j, originalUrl, thumbUrl, optimizedUrl };
      }
      const [videoThumbUrl, optimizedUrl] = await Promise.all([
        j.video_thumb_key
          ? presignGet(c.env.R2_ACCESS_KEY_ID, c.env.R2_SECRET_ACCESS_KEY, S3_REGION, host, j.video_thumb_key, 900)
          : null,
        j.optimize_status === "completed" && j.optimized_key
          ? presignGet(c.env.R2_ACCESS_KEY_ID, c.env.R2_SECRET_ACCESS_KEY, S3_REGION, host, j.optimized_key, 900)
          : null,
      ]);
      return { ...j, originalUrl, videoThumbUrl, optimizedUrl };
    })
  );

  return c.json({ jobs, total, page, perPage });
});

// GET /jobs?userId=&folderId=&type=&page=&perPage= — a specific user's jobs,
// enriched with presigned URLs exactly like the user's own /api/videos listing.
admin.get("/jobs", requireAdmin, async (c) => {
  const userId = c.req.query("userId") || "";
  if (!userId) return c.json({ error: "userId is required" }, 400);
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10) || 1);
  const perPage = Math.min(200, Math.max(1, parseInt(c.req.query("perPage") || "60", 10) || 60));
  const folderRaw = c.req.query("folderId");
  const folderId = typeof folderRaw === "string" && folderRaw.length ? folderRaw : undefined;
  const type = c.req.query("type");
  const mediaType = type === "image" ? "image" : type === "video" ? "video" : undefined;

  const { rows, total } = await listUserJobsFiltered(c.env.DB, userId, { folderId, mediaType, page, perPage });

  const host = getR2Host(c.env.R2_ENDPOINT, c.env.R2_BUCKET_NAME);
  const jobs = await Promise.all(
    rows.map(async (j) => {
      const isImage = j.media_type === "image";
      const originalUrl = await presignGet(
        c.env.R2_ACCESS_KEY_ID, c.env.R2_SECRET_ACCESS_KEY, S3_REGION, host, j.r2_video_key, 3600
      );
      if (isImage) {
        if (j.optimize_status !== "completed") return { ...j, originalUrl };
        const [thumbUrl, optimizedUrl] = await Promise.all([
          j.optimized_thumb_key
            ? presignGet(c.env.R2_ACCESS_KEY_ID, c.env.R2_SECRET_ACCESS_KEY, S3_REGION, host, j.optimized_thumb_key, 900)
            : null,
          j.optimized_key
            ? presignGet(c.env.R2_ACCESS_KEY_ID, c.env.R2_SECRET_ACCESS_KEY, S3_REGION, host, j.optimized_key, 900)
            : null,
        ]);
        return { ...j, originalUrl, thumbUrl, optimizedUrl };
      }
      const [videoThumbUrl, optimizedUrl] = await Promise.all([
        j.video_thumb_key
          ? presignGet(c.env.R2_ACCESS_KEY_ID, c.env.R2_SECRET_ACCESS_KEY, S3_REGION, host, j.video_thumb_key, 900)
          : null,
        j.optimize_status === "completed" && j.optimized_key
          ? presignGet(c.env.R2_ACCESS_KEY_ID, c.env.R2_SECRET_ACCESS_KEY, S3_REGION, host, j.optimized_key, 900)
          : null,
      ]);
      return { ...j, originalUrl, videoThumbUrl, optimizedUrl };
    })
  );

  return c.json({ jobs, total, page, perPage });
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

    // Variant upsert: re-optimizing a format overwrites that format only; other
    // formats' variants are left untouched (no cross-format R2 deletion).
    const seg = userSegmentFromKey(job.r2_video_key);
    const folder = folderSegmentFromKey(job.r2_video_key);
    const optContainer = container ?? (codec === "libsvtav1" ? "webm" : "mp4");
    const optFormat = isImage ? (format ?? "webp") : optContainer;
    const optimizedKey = isImage
      ? r2Keys.optimizedImage(seg, folder, jobId, optFormat!)
      : r2Keys.optimizedVideo(seg, folder, jobId, optContainer as "mp4" | "mkv" | "webm");
    const thumbKey = isImage ? r2Keys.thumbImage(seg, folder, jobId) : null;
    await upsertOptimization(c.env.DB, isImage
      ? { jobId, mediaType: "image", format: optFormat!, quality, maxDim, r2Key: optimizedKey }
      : { jobId, mediaType: "video", format: optContainer, codec: codec ?? "libx264", crf, maxDim, r2Key: optimizedKey });

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

// ── Users + folders (admin file tree) ────────────────────────────────────────

// GET /users — all users with folder/file counts and total bytes.
admin.get("/users", requireAdmin, async (c) => {
  const rows = await c.env.DB
    .prepare(
      `SELECT u.id, u.email, u.role, u.created_at,
         (SELECT COUNT(*) FROM folders f WHERE f.user_id = u.id) AS folder_count,
         (SELECT COUNT(*) FROM jobs j WHERE j.user_id = u.id) AS file_count,
         (SELECT COALESCE(SUM(j.file_size), 0) FROM jobs j WHERE j.user_id = u.id) AS total_size
       FROM users u ORDER BY u.created_at DESC`
    )
    .all();
  return c.json({ users: rows.results ?? [] });
});

// GET /folders?userId= — a user's folders (flat, with file_count + size).
admin.get("/folders", requireAdmin, async (c) => {
  const userId = c.req.query("userId") || "";
  if (!userId) return c.json({ error: "userId is required" }, 400);
  const rows = await c.env.DB
    .prepare(
      `SELECT f.id, f.parent_id, f.name, f.created_at,
         (SELECT COUNT(*) FROM jobs j WHERE j.user_id = f.user_id
            AND COALESCE(j.folder_id, '') = COALESCE(f.id, '')) AS file_count,
         (SELECT COALESCE(SUM(j.file_size), 0) FROM jobs j WHERE j.user_id = f.user_id
            AND COALESCE(j.folder_id, '') = COALESCE(f.id, '')) AS size
       FROM folders f WHERE f.user_id = ? ORDER BY f.name`
    )
    .bind(userId)
    .all();
  return c.json({ folders: rows.results ?? [] });
});

// POST /folders {userId, name, parentId?} — create a folder for any user.
admin.post("/folders", requireAdmin, async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const userId = typeof body.userId === "string" ? body.userId : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const parentId = typeof body.parentId === "string" ? body.parentId : null;
  if (!userId) return c.json({ error: "userId is required" }, 400);

  const err = validateFolderName(name);
  if (err) return c.json({ error: err }, 400);
  if (parentId) {
    const parent = await getFolder(c.env.DB, parentId);
    if (!parent || parent.user_id !== userId) return c.json({ error: "Parent folder not found" }, 404);
  }

  const dup = await c.env.DB
    .prepare("SELECT 1 FROM folders WHERE user_id = ? AND COALESCE(parent_id, '') = ? AND name = ?")
    .bind(userId, parentId ?? "", name)
    .first();
  if (dup) return c.json({ error: "A folder with this name already exists here", code: "DUPLICATE_NAME" }, 409);

  const id = crypto.randomUUID();
  await c.env.DB
    .prepare("INSERT INTO folders (id, user_id, parent_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, userId, parentId, name, new Date().toISOString(), new Date().toISOString())
    .run();
  return c.json({ ok: true, id, name, parent_id: parentId }, 201);
});

// PATCH /folders/:id {name?, parentId?} — rename/move any user's folder.
admin.patch("/folders/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const folder = await getFolder(c.env.DB, id);
  if (!folder) return c.json({ error: "Not found" }, 404);

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const newName = typeof body.name === "string" ? body.name.trim() : null;
  const newParent = typeof body.parentId === "string" ? body.parentId : null;

  if (newName !== null) {
    const err = validateFolderName(newName);
    if (err) return c.json({ error: err }, 400);
  }
  if (newParent !== null && newParent !== folder.parent_id) {
    if (newParent === id) return c.json({ error: "A folder cannot be its own parent" }, 400);
    const parent = await getFolder(c.env.DB, newParent);
    if (!parent || parent.user_id !== folder.user_id) return c.json({ error: "Parent folder not found" }, 404);
    const desc = await collectFolderDescendants(c.env.DB, id);
    if (desc.includes(newParent)) return c.json({ error: "Cannot move a folder into its own descendant" }, 400);
  }

  const targetParent = newParent === null ? folder.parent_id : newParent;
  const targetName = newName ?? folder.name;

  if ((newName !== null && newName !== folder.name) || (newParent !== null && newParent !== folder.parent_id)) {
    const dup = await c.env.DB
      .prepare("SELECT 1 FROM folders WHERE user_id = ? AND COALESCE(parent_id, '') = ? AND name = ? AND id <> ?")
      .bind(folder.user_id, targetParent ?? "", targetName, id)
      .first();
    if (dup) return c.json({ error: "A folder with this name already exists here", code: "DUPLICATE_NAME" }, 409);
  }

  await c.env.DB
    .prepare("UPDATE folders SET name = ?, parent_id = ?, updated_at = ? WHERE id = ?")
    .bind(targetName, targetParent, new Date().toISOString(), id)
    .run();
  return c.json({ ok: true, id, name: targetName, parent_id: targetParent });
});

// DELETE /folders/:id — recursive (jobs + R2 + descendant folders).
admin.delete("/folders/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const folder = await getFolder(c.env.DB, id);
  if (!folder) return c.json({ error: "Not found" }, 404);
  const res = await deleteFolderCompletely(c.env, id);
  return c.json({ ok: true, deleted: res });
});

// ── Processing galleries (data-driven, dynamic tabs) ─────────────────────────

// GET /optimizations?format= — format-independent optimization variants.
// Formats come from completed variants (dynamic tabs); items are the variants
// with original size + output size + saved % + playable/preview URL.
admin.get("/optimizations", requireAdmin, async (c) => {
  const formatFilter = c.req.query("format");
  const formats = await listOptimizationFormats(c.env.DB);
  const host = getR2Host(c.env.R2_ENDPOINT, c.env.R2_BUCKET_NAME);

  const base = `SELECT o.id, o.job_id, o.media_type, o.format, o.codec, o.crf, o.quality,
       o.max_dim, o.r2_key, o.size, o.duration, o.status, o.error_message, o.updated_at,
       j.original_filename, j.file_size, j.optimized_thumb_key, j.video_thumb_key, j.user_id,
       u.email AS user_email
    FROM optimizations o
    LEFT JOIN jobs j ON j.id = o.job_id
    LEFT JOIN users u ON u.id = j.user_id
    WHERE o.status = 'completed'`;
  const rows = formatFilter
    ? await c.env.DB.prepare(`${base} AND o.format = ? ORDER BY o.updated_at DESC LIMIT 300`).bind(formatFilter).all<Record<string, unknown>>()
    : await c.env.DB.prepare(`${base} ORDER BY o.updated_at DESC LIMIT 300`).all<Record<string, unknown>>();

  const items = await Promise.all(
    (rows.results ?? []).map(async (o) => {
      const thumbKey = o.media_type === "image" ? o.optimized_thumb_key : o.video_thumb_key;
      const [thumbUrl, url] = await Promise.all([
        thumbKey
          ? presignGet(c.env.R2_ACCESS_KEY_ID, c.env.R2_SECRET_ACCESS_KEY, S3_REGION, host, thumbKey as string, 900)
          : null,
        presignGet(c.env.R2_ACCESS_KEY_ID, c.env.R2_SECRET_ACCESS_KEY, S3_REGION, host, o.r2_key as string, 900),
      ]);
      const orig = Number(o.file_size) || 0;
      const out = Number(o.size) || 0;
      const savedPct = orig && out ? Math.max(0, Math.round((1 - out / orig) * 100)) : null;
      return { ...o, thumbUrl, url, savedPct };
    })
  );

  return c.json({ formats, items });
});

// DELETE /optimizations/:id — delete one variant (R2 object + row).
admin.delete("/optimizations/:id", requireAdmin, async (c) => {
  const opt = await getOptimizationById(c.env.DB, c.req.param("id"));
  if (!opt) return c.json({ error: "Not found" }, 404);
  await Promise.allSettled([c.env.R2.delete(opt.r2_key)]);
  await deleteOptimizationById(c.env.DB, opt.id);
  // If it was the job's "current" optimized output, clear the stale pointer.
  const job = await getJob(c.env.DB, opt.job_id);
  if (job && job.optimized_key === opt.r2_key) {
    await c.env.DB
      .prepare("UPDATE jobs SET optimized_key = NULL, optimize_status = 'none', updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), opt.job_id)
      .run();
  }
  return c.json({ ok: true, deleted: opt.id });
});

// GET /chunk-groups?videoId= — chunks grouped by parent video (dynamic tabs).
admin.get("/chunk-groups", requireAdmin, async (c) => {
  const videoId = c.req.query("videoId") || "";
  const host = getR2Host(c.env.R2_ENDPOINT, c.env.R2_BUCKET_NAME);
  const groups = await c.env.DB
    .prepare(
      `SELECT c.job_id, j.original_filename AS title, COUNT(*) AS count
       FROM chunks c JOIN jobs j ON j.id = c.job_id
       WHERE c.deleted = 0 GROUP BY c.job_id ORDER BY j.original_filename`
    )
    .all<{ job_id: string; title: string; count: number }>();

  const where = videoId ? "AND c.job_id = ?" : "";
  const rows = await c.env.DB
    .prepare(
      `SELECT c.id, c.job_id, c.chunk_number, c.start_sec, c.end_sec, c.duration, c.r2_key,
         c.file_size, c.width, c.height, c.created_at
       FROM chunks c JOIN jobs j ON j.id = c.job_id
       WHERE c.deleted = 0 ${where} ORDER BY c.job_id, c.chunk_number ASC LIMIT 2000`
    )
    .bind(...(videoId ? [videoId] : []))
    .all<{
      id: string; job_id: string; chunk_number: number; start_sec: number; end_sec: number;
      duration: number; r2_key: string; file_size: number; width: number | null; height: number | null; created_at: string;
    }>();

  const chunks = await Promise.all(
    (rows.results ?? []).map(async (ch) => ({
      ...ch,
      playUrl: await presignGet(c.env.R2_ACCESS_KEY_ID, c.env.R2_SECRET_ACCESS_KEY, S3_REGION, host, ch.r2_key, 900),
    }))
  );
  return c.json({ groups: groups.results ?? [], chunks });
});

// GET /frame-groups?videoId= — extracted frames grouped by source video (dynamic tabs).
admin.get("/frame-groups", requireAdmin, async (c) => {
  const videoId = c.req.query("videoId") || "";
  const host = getR2Host(c.env.R2_ENDPOINT, c.env.R2_BUCKET_NAME);
  const groups = await c.env.DB
    .prepare(
      `SELECT fr.job_id, j.original_filename AS title, COUNT(*) AS count
       FROM frames fr JOIN jobs j ON j.id = fr.job_id
       WHERE fr.deleted = 0 GROUP BY fr.job_id ORDER BY j.original_filename`
    )
    .all<{ job_id: string; title: string; count: number }>();

  const where = videoId ? "AND fr.job_id = ?" : "";
  const rows = await c.env.DB
    .prepare(
      `SELECT fr.id, fr.job_id, fr.frame_number, fr.source_frame_number, fr.timestamp, fr.r2_key,
         fr.width, fr.height, fr.created_at
       FROM frames fr JOIN jobs j ON j.id = fr.job_id
       WHERE fr.deleted = 0 ${where} ORDER BY fr.job_id, fr.frame_number ASC LIMIT 4000`
    )
    .bind(...(videoId ? [videoId] : []))
    .all<{
      id: string; job_id: string; frame_number: number; source_frame_number: number; timestamp: number;
      r2_key: string; width: number; height: number; created_at: string;
    }>();

  const frames = await Promise.all(
    (rows.results ?? []).map(async (f) => {
      const [thumbUrl, fullUrl] = await Promise.all([
        presignGet(c.env.R2_ACCESS_KEY_ID, c.env.R2_SECRET_ACCESS_KEY, S3_REGION, host, f.r2_key.replace("/frames/full/", "/frames/thumbs/"), 900),
        presignGet(c.env.R2_ACCESS_KEY_ID, c.env.R2_SECRET_ACCESS_KEY, S3_REGION, host, f.r2_key, 900),
      ]);
      return { ...f, thumbUrl, fullUrl };
    })
  );
  return c.json({ groups: groups.results ?? [], frames });
});

// GET /optframes?format= — optimized frame images (separate gallery). Derived
// from completed opt_batches; format tabs are the distinct batch formats.
admin.get("/optframes", requireAdmin, async (c) => {
  const formatFilter = c.req.query("format");
  const host = getR2Host(c.env.R2_ENDPOINT, c.env.R2_BUCKET_NAME);
  const formats = await c.env.DB
    .prepare(`SELECT format, COUNT(*) AS count FROM opt_batches WHERE status = 'completed' GROUP BY format ORDER BY format`)
    .all<{ format: string; count: number }>();

  const batches = await c.env.DB
    .prepare(
      `SELECT b.id, b.job_id, b.format, b.quality, b.max_dim, b.frame_ids, b.completed_at,
         j.original_filename, j.user_id, u.email AS user_email
       FROM opt_batches b
       LEFT JOIN jobs j ON j.id = b.job_id
       LEFT JOIN users u ON u.id = j.user_id
       WHERE b.status = 'completed' ORDER BY b.completed_at DESC LIMIT 100`
    )
    .all<{
      id: string; job_id: string; format: string; quality: number; max_dim: number | null;
      frame_ids: string; completed_at: string | null; original_filename: string | null;
      user_id: string; user_email: string | null;
    }>();

  const items: Array<Record<string, unknown>> = [];
  for (const b of batches.results ?? []) {
    if (formatFilter && b.format !== formatFilter) continue;
    const job = await getJob(c.env.DB, b.job_id);
    if (!job) continue;
    const seg = userSegmentFromKey(job.r2_video_key);
    const folder = folderSegmentFromKey(job.r2_video_key);
    const frameIds = JSON.parse(b.frame_ids) as string[];
    const frames = await listFramesByIds(c.env.DB, b.job_id, frameIds);
    const fmt = b.format as ImageFormat;
    for (const f of frames) {
      const key = r2Keys.optimizedFrame(seg, folder, b.job_id, fmt, f.frame_number);
      const head = await c.env.R2.head(key);
      items.push({
        id: `${b.id}:${f.id}`,
        job_id: b.job_id,
        frame_number: f.frame_number,
        width: f.width,
        height: f.height,
        format: b.format,
        quality: b.quality,
        size: head?.size ?? null,
        filename: `${b.original_filename ?? "video"} — frame ${String(f.frame_number).padStart(4, "0")}`,
        user_email: b.user_email,
        url: await presignGet(c.env.R2_ACCESS_KEY_ID, c.env.R2_SECRET_ACCESS_KEY, S3_REGION, host, key, 900),
        thumbUrl: await presignGet(c.env.R2_ACCESS_KEY_ID, c.env.R2_SECRET_ACCESS_KEY, S3_REGION, host, key, 900),
      });
    }
    if (items.length > 2000) break;
  }

  return c.json({ formats: formats.results ?? [], items });
});

// POST /optframes/delete {job_id, format, frameNumbers[]} — delete optimized
// frame objects of one format for the given frame numbers.
admin.post("/optframes/delete", requireAdmin, async (c) => {
  let body: { jobId?: unknown; format?: unknown; frameNumbers?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  const format = typeof body.format === "string" ? body.format : "";
  const frameNumbers = Array.isArray(body.frameNumbers)
    ? body.frameNumbers.filter((x): x is number => typeof x === "number" && Number.isInteger(x))
    : [];
  if (!jobId || !format || !frameNumbers.length) return c.json({ error: "jobId, format, frameNumbers required" }, 400);

  const job = await getJob(c.env.DB, jobId);
  if (!job) return c.json({ error: "Not found" }, 404);
  const seg = userSegmentFromKey(job.r2_video_key);
  const folder = folderSegmentFromKey(job.r2_video_key);
  const fmt = format as ImageFormat;
  for (const n of frameNumbers) {
    await Promise.allSettled([c.env.R2.delete(r2Keys.optimizedFrame(seg, folder, jobId, fmt, n))]);
  }
  return c.json({ ok: true, deleted: frameNumbers.length });
});

export default admin;
