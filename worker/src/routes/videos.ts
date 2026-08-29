import { Hono } from "hono";
import type { Env } from "../env";
import { S3_REGION } from "../env";
import { getR2Host, presignGet } from "../lib/s3";
import { requireAuth } from "../middleware/auth";
import { listUserJobsFiltered } from "../db/jobs";
import type { JwtUser } from "../types";

const videos = new Hono<{ Bindings: Env; Variables: { user: JwtUser } }>();

// GET /videos?folderId=&type=&page=&perPage= — current user's own jobs.
// folderId absent => all folders ("All Media"); folderId present => only that
// folder (empty string not accepted; frontend uses no param for the root view).
// type = all | image | video. Each job gets a presigned originalUrl (preview /
// download) plus thumb + optimized URLs when available.
videos.get("/", requireAuth, async (c) => {
  const user = c.get("user");
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10) || 1);
  const perPage = Math.min(200, Math.max(1, parseInt(c.req.query("perPage") || "60", 10) || 60));
  const folderRaw = c.req.query("folderId");
  const folderId = typeof folderRaw === "string" && folderRaw.length ? folderRaw : undefined;
  const type = c.req.query("type");
  const mediaType = type === "image" ? "image" : type === "video" ? "video" : undefined;

  const { rows, total } = await listUserJobsFiltered(c.env.DB, user.sub, {
    folderId, // undefined => all; a real id => that folder
    mediaType,
    page,
    perPage,
  });

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
      // Video: poster thumbnail once frames are extracted, optimized URL once done.
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

export default videos;
