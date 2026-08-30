import type { Env } from "../env";
import { listFramesByIds } from "../db/opt";
import { r2Keys, userSegmentFromKey, folderSegmentFromKey } from "./r2";
import type { ImageFormat } from "./r2";

interface CleanupJobRow {
  id: string;
  r2_video_key: string;
  optimized_key: string | null;
  optimized_thumb_key: string | null;
  video_thumb_key: string | null;
}

/** Permanently delete a job, its frames, chunks, opt_batches, exports and every
 * R2 object it owns. Shared by the admin delete route and the user dashboard. */
export async function deleteJobCompletely(env: Env, jobId: string): Promise<boolean> {
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(jobId).first<CleanupJobRow>();
  if (!job) return false;
  const seg = userSegmentFromKey(job.r2_video_key);
  const folder = folderSegmentFromKey(job.r2_video_key);

  const frames = await env.DB.prepare("SELECT r2_key FROM frames WHERE job_id = ?").bind(jobId).all<{ r2_key: string }>();
  for (const f of frames.results ?? []) {
    await Promise.allSettled([
      env.R2.delete(f.r2_key),
      env.R2.delete(f.r2_key.replace("/frames/full/", "/frames/thumbs/")),
    ]);
  }

  const batches = await env.DB
    .prepare("SELECT frame_ids, format FROM opt_batches WHERE job_id = ?")
    .bind(jobId)
    .all<{ frame_ids: string; format: string }>();
  for (const b of batches.results ?? []) {
    const ids = JSON.parse(b.frame_ids) as string[];
    const fr = await listFramesByIds(env.DB, jobId, ids);
    const fmt = b.format as ImageFormat;
    for (const f of fr) await Promise.allSettled([env.R2.delete(r2Keys.optimizedFrame(seg, folder, jobId, fmt, f.frame_number))]);
  }

  const chunks = await env.DB.prepare("SELECT r2_key FROM chunks WHERE job_id = ?").bind(jobId).all<{ r2_key: string }>();
  for (const ch of chunks.results ?? []) await Promise.allSettled([env.R2.delete(ch.r2_key)]);

  const exports = await env.DB
    .prepare("SELECT r2_key FROM exports WHERE job_id = ? AND r2_key IS NOT NULL")
    .bind(jobId)
    .all<{ r2_key: string }>();
  for (const e of exports.results ?? []) await Promise.allSettled([env.R2.delete(e.r2_key!)]);

  // Every format-specific variant (each has its own R2 object).
  const opts = await env.DB
    .prepare("SELECT r2_key FROM optimizations WHERE job_id = ?")
    .bind(jobId)
    .all<{ r2_key: string }>();
  const optKeys = new Set(opts.results?.map((o) => o.r2_key) ?? []);
  if (job.optimized_key) optKeys.add(job.optimized_key);
  await Promise.allSettled([
    env.R2.delete(job.r2_video_key),
    ...[...optKeys].map((k) => env.R2.delete(k)),
    ...(job.optimized_thumb_key ? [env.R2.delete(job.optimized_thumb_key)] : []),
    ...(job.video_thumb_key ? [env.R2.delete(job.video_thumb_key)] : []),
  ]);

  await env.DB.prepare("DELETE FROM opt_batches WHERE job_id = ?").bind(jobId).run();
  await env.DB.prepare("DELETE FROM optimizations WHERE job_id = ?").bind(jobId).run();
  await env.DB.prepare("DELETE FROM jobs WHERE id = ?").bind(jobId).run();
  return true;
}
