import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth } from "../middleware/auth";
import { listUserJobs } from "../db/jobs";
import type { JwtUser } from "../types";

const videos = new Hono<{ Bindings: Env; Variables: { user: JwtUser } }>();

// GET /videos — current user's own jobs (never other users')
videos.get("/", requireAuth, async (c) => {
  const user = c.get("user");
  const jobs = await listUserJobs(c.env.DB, user.sub);
  return c.json({ jobs });
});

export default videos;
