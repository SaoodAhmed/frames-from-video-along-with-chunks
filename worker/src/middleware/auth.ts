import { createMiddleware } from "hono/factory";
import type { Env } from "../env";
import { verifyToken } from "../lib/jwt";
import type { JwtUser } from "../types";

type AuthEnv = { Bindings: Env; Variables: { user: JwtUser } };

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim();
}

/** Any authenticated user. Sets c.var.user. */
export const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
  const token = bearerToken(c.req.header("Authorization"));
  if (!token) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
  const payload = await verifyToken(token, c.env.AUTH_SECRET);
  if (!payload || typeof payload.sub !== "string") {
    return c.json({ error: "Unauthorized", code: "INVALID_TOKEN" }, 401);
  }
  c.set("user", {
    sub: payload.sub,
    email: typeof payload.email === "string" ? payload.email : "",
    role: payload.role === "admin" ? "admin" : "user",
  });
  await next();
});

/** Admin only. Distinguishes 401 (unauthenticated) from 403 (forbidden). */
export const requireAdmin = createMiddleware<AuthEnv>(async (c, next) => {
  const token = bearerToken(c.req.header("Authorization"));
  if (!token) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
  const payload = await verifyToken(token, c.env.AUTH_SECRET);
  if (!payload || typeof payload.sub !== "string") {
    return c.json({ error: "Unauthorized", code: "INVALID_TOKEN" }, 401);
  }
  if (payload.role !== "admin") {
    return c.json({ error: "Forbidden", code: "NOT_ADMIN" }, 403);
  }
  c.set("user", { sub: payload.sub, email: String(payload.email ?? ""), role: "admin" });
  await next();
});
