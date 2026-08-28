import { Hono } from "hono";
import type { Env } from "../env";
import { S3_REGION } from "../env";
import { getR2Host, presignGet } from "../lib/s3";
import { requireAuth } from "../middleware/auth";
import { listUserJobs } from "../db/jobs";
import type { JwtUser } from "../types";

const videos = new Hono<{ Bindings: Env; Variables: { user: JwtUser } }>();

// GET /videos — current user's own jobs (never other users'). Image jobs get
// presigned thumb/optimized URLs so the gallery can render them.
videos.get("/", requireAuth, async (c) => {
  const user = c.get("user");
  const jobs = await listUserJobs(c.env.DB, user.sub);
  const host = getR2Host(c.env.R2_ENDPOINT, c.env.R2_BUCKET_NAME);
  const rows = await Promise.all(
    jobs.map(async (j) => {
      if (j.media_type !== "image" || j.optimize_status !== "completed") return j;
      const [thumbUrl, optimizedUrl] = await Promise.all([
        j.optimized_thumb_key
          ? presignGet(c.env.R2_ACCESS_KEY_ID, c.env.R2_SECRET_ACCESS_KEY, S3_REGION, host, j.optimized_thumb_key, 900)
          : null,
        j.optimized_key
          ? presignGet(c.env.R2_ACCESS_KEY_ID, c.env.R2_SECRET_ACCESS_KEY, S3_REGION, host, j.optimized_key, 900)
          : null,
      ]);
      return { ...j, thumbUrl, optimizedUrl };
    })
  );
  return c.json({ jobs: rows });
});

export default videos;
