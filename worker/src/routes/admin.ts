import { Hono } from "hono";
import type { Env } from "../env";
import { requireAdmin } from "../middleware/auth";
import { listAllJobs, countJobsByStatus } from "../db/jobs";
import type { JwtUser } from "../types";

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

// DELETE /jobs/:id — permanently delete a job, its frames, exports and R2 objects
admin.delete("/jobs/:id", requireAdmin, async (c) => {
  const jobId = c.req.param("id");
  const job = await c.env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(jobId).first();
  if (!job) return c.json({ error: "Not found" }, 404);

  // Frames
  const frames = await c.env.DB.prepare("SELECT r2_key FROM frames WHERE job_id = ?").bind(jobId).all<{ r2_key: string }>();
  for (const f of frames.results ?? []) {
    await Promise.allSettled([
      c.env.R2.delete(f.r2_key),
      c.env.R2.delete(f.r2_key.replace("/frames/full/", "/frames/thumbs/")),
    ]);
  }
  // Chunks
  const chunks = await c.env.DB.prepare("SELECT r2_key FROM chunks WHERE job_id = ?").bind(jobId).all<{ r2_key: string }>();
  for (const ch of chunks.results ?? []) await Promise.allSettled([c.env.R2.delete(ch.r2_key)]);
  // Exports (frame + chunk zips)
  const exports = await c.env.DB.prepare("SELECT r2_key FROM exports WHERE job_id = ? AND r2_key IS NOT NULL").bind(jobId).all<{ r2_key: string }>();
  for (const e of exports.results ?? []) await Promise.allSettled([c.env.R2.delete(e.r2_key!)]);
  // Original video
  await Promise.allSettled([c.env.R2.delete((job as { r2_video_key: string }).r2_video_key)]);

  await c.env.DB.prepare("DELETE FROM jobs WHERE id = ?").bind(jobId).run();
  return c.json({ ok: true, deleted: jobId });
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
