import { Hono } from "hono";
import type { Env } from "../env";
import { S3_REGION } from "../env";
import { getR2Host, presignPutPart } from "../lib/s3";
import { requireAuth } from "../middleware/auth";
import { createJob, getJobForUser, getJob, transitionOptimize } from "../db/jobs";
import { triggerGitHubDispatch } from "../lib/github";
import { r2Keys } from "../types";
import type { JwtUser } from "../types";

const uploads = new Hono<{ Bindings: Env; Variables: { user: JwtUser } }>();

// 50 MB per part — small enough to proxy through the Worker on the free tier
// (request body limit is 100 MB) while keeping the part count low.
const CHUNK_SIZE = 50 * 1024 * 1024;
const PART_TTL_SEC = 15 * 60; // presigned URLs valid 15 minutes
const MAX_PARTS = 10000;

// Any container ffmpeg can decode. Accept by MIME (video/*) OR by extension as a
// fallback, because some containers (e.g. .mxf, .ts) report a non-video MIME or
// none at all. Actual decodability is verified by the runner with ffprobe.
const VIDEO_EXTS = new Set([
  ".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm", ".ogv", ".ogg", ".3gp",
  ".3g2", ".flv", ".wmv", ".mpg", ".mpeg", ".ts", ".m2ts", ".mts", ".mxf",
  ".mp2", ".ogm", ".divx", ".asf", ".vob", ".m2v", ".mpe",
]);

function classifyMedia(filename: string, mimeType: string): "video" | "image" | null {
  const ext = "." + (filename.split(".").pop() ?? "").toLowerCase();
  const m = mimeType.toLowerCase();
  if (m.startsWith("video/") || VIDEO_EXTS.has(ext)) return "video";
  if (m.startsWith("image/")) return "image";
  return null;
}

function sanitizeFilename(raw: string): string {
  // Keep only safe filename characters; never trust client-supplied paths.
  const base = raw.split(/[\\/]/).pop() ?? "video.mp4";
  const cleaned = base.replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, "_");
  return cleaned.slice(0, 180) || "video.mp4";
}

uploads.post("/create", requireAuth, async (c) => {
  const user = c.get("user");
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const rawFilename = typeof body.filename === "string" ? body.filename : "";
  const size = typeof body.size === "number" ? body.size : 0;
  const mimeType = typeof body.mimeType === "string" ? body.mimeType : "";

  if (!rawFilename || size <= 0) {
    return c.json({ error: "filename and size are required" }, 400);
  }
  const maxSize = parseInt(c.env.MAX_UPLOAD_SIZE || "2147483648", 10);
  if (size > maxSize) {
    return c.json({ error: `File exceeds maximum upload size (${Math.floor(maxSize / 1e6)} MB)` }, 413);
  }
  const mediaType = classifyMedia(rawFilename, mimeType);
  if (mediaType === null) {
    return c.json({ error: "Unsupported media type (expected a video or image)" }, 415);
  }

  const filename = sanitizeFilename(rawFilename);
  const jobId = crypto.randomUUID();
  const r2Key =
    mediaType === "image"
      ? r2Keys.originalImage(user.sub, jobId, filename)
      : r2Keys.originalVideo(user.sub, jobId, filename);

  // Insert the job record first (status = uploaded).
  await createJob(c.env.DB, {
    id: jobId,
    user_id: user.sub,
    original_filename: filename,
    r2_video_key: r2Key,
    file_size: size,
    mime_type: mimeType || (mediaType === "image" ? "image/jpeg" : "video/mp4"),
    media_type: mediaType,
  });

  // Initiate multipart upload on R2.
  const mpu = await c.env.R2.createMultipartUpload(r2Key);
  const partCount = Math.min(Math.max(1, Math.ceil(size / CHUNK_SIZE)), MAX_PARTS);

  const host = getR2Host(c.env.R2_ENDPOINT, c.env.R2_BUCKET_NAME);
  const partUrls = [];
  for (let i = 1; i <= partCount; i++) {
    partUrls.push({
      partNumber: i,
      url: await presignPutPart(
        c.env.R2_ACCESS_KEY_ID,
        c.env.R2_SECRET_ACCESS_KEY,
        S3_REGION,
        host,
        r2Key,
        mpu.uploadId,
        i,
        PART_TTL_SEC
      ),
    });
  }

  return c.json({
    jobId,
    uploadId: mpu.uploadId,
    r2Key,
    chunkSize: CHUNK_SIZE,
    partUrls,
    expiresIn: PART_TTL_SEC,
  }, 201);
});

/**
 * PUT /part/:jobId/:partNumber — browser uploads a part to the Worker, which
 * relays it into the R2 multipart upload. Same-origin so no bucket CORS is
 * needed (the R2 bucket has no CORS policy and direct browser→R2 PUTs are
 * blocked). The uploadId is carried in the X-Upload-Id header.
 */
uploads.put("/part/:jobId/:partNumber", requireAuth, async (c) => {
  const user = c.get("user");
  const jobId = c.req.param("jobId");
  const partNumber = parseInt(c.req.param("partNumber"), 10);
  const uploadId = c.req.header("x-upload-id") || "";

  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS) {
    return c.json({ error: "Invalid part number" }, 400);
  }
  if (!uploadId) return c.json({ error: "X-Upload-Id header is required" }, 400);

  const job = await getJobForUser(c.env.DB, user.sub, jobId);
  if (!job) return c.json({ error: "Not found" }, 404);
  if (job.status !== "uploaded") {
    return c.json({ error: "Job is not in uploaded state" }, 409);
  }

  const body = c.req.raw.body;
  if (!body) return c.json({ error: "Empty body" }, 400);

  try {
    const mpu = await c.env.R2.resumeMultipartUpload(job.r2_video_key, uploadId);
    const part = await mpu.uploadPart(partNumber, body);
    return c.json({ ok: true, partNumber, etag: part.etag });
  } catch (err) {
    console.error("part upload failed", err);
    return c.json({ error: "Failed to upload part" }, 500);
  }
});

uploads.post("/complete", requireAuth, async (c) => {
  const user = c.get("user");
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  const uploadId = typeof body.uploadId === "string" ? body.uploadId : "";
  const parts = Array.isArray(body.parts)
    ? (body.parts as Array<{ partNumber: number; etag: string }>)
    : [];

  if (!jobId || !uploadId || parts.length === 0) {
    return c.json({ error: "jobId, uploadId and parts are required" }, 400);
  }
  for (const p of parts) {
    if (!Number.isInteger(p.partNumber) || typeof p.etag !== "string") {
      return c.json({ error: "Invalid parts list" }, 400);
    }
  }

  const job = await getJobForUser(c.env.DB, user.sub, jobId);
  if (!job) return c.json({ error: "Not found" }, 404);
  if (job.status !== "uploaded") {
    return c.json({ error: "Job is not in uploaded state" }, 409);
  }

  try {
    const mpu = await c.env.R2.resumeMultipartUpload(job.r2_video_key, uploadId);
    const done = await mpu.complete(
      parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag }))
    );
    // Verify the object actually exists before declaring success.
    const head = await c.env.R2.head(job.r2_video_key);
    if (!head) {
      return c.json({ error: "Uploaded object not found on R2" }, 502);
    }
    const now = new Date().toISOString();
    await c.env.DB.prepare(
      "UPDATE jobs SET file_size = ?, updated_at = ? WHERE id = ? AND status = 'uploaded'"
    )
      .bind(done.size ?? head.size ?? job.file_size, now, jobId)
      .run();

    // Images need no admin step — auto-queue optimization now that the object
    // exists (queuing at create would race the multipart upload). The output
    // keys are fixed here so the runner never has to compute them.
    if (job.media_type === "image") {
      const queued = await transitionOptimize(c.env.DB, jobId, "none", "queued", {
        optimized_key: r2Keys.optimizedImage(user.sub, jobId),
        optimized_thumb_key: r2Keys.thumbImage(user.sub, jobId),
      });
      if (queued) {
        const exec = c.executionCtx;
        const waitUntil = exec?.waitUntil ? exec.waitUntil.bind(exec) : ((p: Promise<unknown>) => void p);
        await triggerGitHubDispatch(c.env, { waitUntil }, { jobId, action: "optimize" });
      }
    }

    return c.json({ ok: true, jobId, size: done.size ?? head.size });
  } catch (err) {
    console.error("upload complete failed", err);
    return c.json({ error: "Failed to complete upload" }, 500);
  }
});

/** Delete an un-processed upload (owner or admin). */
uploads.delete("/:jobId", requireAuth, async (c) => {
  const user = c.get("user");
  const jobId = c.req.param("jobId");
  let body: Record<string, unknown> = {};
  try {
    body = await c.req.json();
  } catch {
    /* optional body */
  }
  const uploadId = typeof body.uploadId === "string" ? body.uploadId : null;

  const job = await getJob(c.env.DB, jobId);
  if (!job) return c.json({ error: "Not found" }, 404);
  if (job.user_id !== user.sub && user.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }
  if (job.status !== "uploaded" && job.status !== "cancelled" && job.status !== "failed") {
    return c.json({ error: "Job has been processed and cannot be deleted this way" }, 409);
  }

  try {
    if (uploadId) {
      const mpu = await c.env.R2.resumeMultipartUpload(job.r2_video_key, uploadId);
      await mpu.abort();
    }
  } catch {
    /* multipart already aborted — ignore */
  }
  try {
    await c.env.R2.delete(job.r2_video_key);
  } catch {
    /* best-effort */
  }
  await c.env.DB.prepare("DELETE FROM jobs WHERE id = ?").bind(jobId).run();
  return c.json({ ok: true, deleted: jobId });
});

export default uploads;
