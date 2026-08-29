import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { STATIC_ASSETS } from "./static";
import authRoutes from "./routes/auth";
import uploadRoutes from "./routes/uploads";
import jobRoutes from "./routes/jobs";
import adminRoutes from "./routes/admin";
import videoRoutes from "./routes/videos";
import folderRoutes from "./routes/folders";
import processorRoutes from "./routes/processor";

const app = new Hono<{ Bindings: Env }>();

// Log unexpected errors for debugging; don't leak internals to clients.
app.onError((err, c) => {
  console.error("Hono onError:", err?.stack ?? err?.message ?? err);
  return c.json({ error: "Internal server error" }, 500);
});

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  })
);

// Security headers
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
});

// Best-effort in-memory rate limiter (per isolate). For hard limits in
// production, enable Cloudflare WAF rate-limiting rules on the zone.
const hitCounters = new Map<string, { count: number; resetAt: number }>();
app.use("/api/auth/*", async (c, next) => {
  const perMin = parseInt(c.env.RATE_LIMIT_PER_MIN || "60", 10);
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const key = `auth:${ip}`;
  const now = Date.now();
  const cur = hitCounters.get(key);
  if (!cur || cur.resetAt < now) {
    hitCounters.set(key, { count: 1, resetAt: now + 60_000 });
    return next();
  }
  cur.count += 1;
  if (cur.count > perMin) {
    return c.json({ error: "Too many requests", code: "RATE_LIMITED" }, 429);
  }
  return next();
});

app.route("/api/auth", authRoutes);
app.route("/api/uploads", uploadRoutes);
app.route("/api/jobs", jobRoutes);
app.route("/api/admin", adminRoutes);
app.route("/api/videos", videoRoutes);
app.route("/api/folders", folderRoutes);
app.route("/api/processor", processorRoutes);

app.get("/api/health", (c) => c.json({ ok: true, service: "frameforge", time: new Date().toISOString() }));

// Serve the frontend (user portal + admin portal) from the in-memory bundle.
// Assets are inlined at build time via esbuild `?raw` imports — no external
// static-assets store, so the worker is a single deployable unit.
app.all("*", async (c) => {
  if (c.req.path.startsWith("/api/")) return c.json({ error: "Not Found" }, 404);
  const asset = STATIC_ASSETS[c.req.path];
  if (!asset) return c.json({ error: "Not Found" }, 404);
  return new Response(asset.data, {
    headers: {
      "content-type": asset.contentType,
      // Asset URLs are content-fixed (no hashing) and change on every deploy —
      // never let a browser or edge cache serve a stale copy.
      "cache-control": "no-cache",
    },
  });
});

export default app;
