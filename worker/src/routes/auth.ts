import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth } from "../middleware/auth";
import { hashPassword, verifyPassword } from "../lib/password";
import { signToken } from "../lib/jwt";
import type { JwtUser } from "../types";

const auth = new Hono<{ Bindings: Env; Variables: { user: JwtUser } }>();

function emailOk(e: unknown): e is string {
  return (
    typeof e === "string" &&
    e.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)
  );
}

function passwordOk(p: unknown): p is string {
  return typeof p === "string" && p.length >= 8 && p.length <= 128;
}

async function getBody(c: { req: { json: () => Promise<unknown> } }) {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

auth.post("/register", async (c) => {
  const body = await getBody(c);
  const email = body.email;
  const password = body.password;
  if (!emailOk(email)) return c.json({ error: "Invalid email address" }, 400);
  if (!passwordOk(password)) {
    return c.json({ error: "Password must be 8-128 characters" }, 400);
  }

  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first();
  if (existing) return c.json({ error: "Email already registered" }, 409);

  const id = crypto.randomUUID();
  const pwHash = await hashPassword(password);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "INSERT INTO users (id, email, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, 'user', ?, ?)"
  )
    .bind(id, email, pwHash, now, now)
    .run();

  const token = await signToken({ sub: id, email, role: "user" }, c.env.AUTH_SECRET);
  return c.json({ token, user: { id, email, role: "user" } }, 201);
});

auth.post("/login", async (c) => {
  const body = await getBody(c);
  const email = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";

  const row = await c.env.DB.prepare(
    "SELECT id, email, password_hash, role FROM users WHERE email = ?"
  )
    .bind(email)
    .first<{ id: string; email: string; password_hash: string; role: string }>();
  if (!row) return c.json({ error: "Invalid email or password" }, 401);

  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) return c.json({ error: "Invalid email or password" }, 401);

  const token = await signToken(
    { sub: row.id, email: row.email, role: row.role },
    c.env.AUTH_SECRET
  );
  return c.json({ token, user: { id: row.id, email: row.email, role: row.role } });
});

auth.get("/me", requireAuth, (c) => {
  return c.json({ user: c.get("user") });
});

/**
 * One-time admin bootstrap. Only succeeds when no admin exists yet and the
 * provided setup token matches the ADMIN_SETUP_TOKEN environment variable.
 * Delete the env var after bootstrapping to lock this route down.
 */
auth.post("/setup-admin", async (c) => {
  const body = await getBody(c);
  const setupToken = typeof body.setupToken === "string" ? body.setupToken : "";
  if (!c.env.ADMIN_SETUP_TOKEN || setupToken !== c.env.ADMIN_SETUP_TOKEN) {
    return c.json({ error: "Invalid setup token" }, 401);
  }
  const email = body.email;
  const password = body.password;
  if (!emailOk(email)) return c.json({ error: "Invalid email address" }, 400);
  if (!passwordOk(password)) {
    return c.json({ error: "Password must be 8-128 characters" }, 400);
  }

  const existingAdmin = await c.env.DB.prepare(
    "SELECT id FROM users WHERE role = 'admin' LIMIT 1"
  ).first();
  if (existingAdmin) return c.json({ error: "Admin already exists" }, 409);

  const id = crypto.randomUUID();
  const pwHash = await hashPassword(password);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "INSERT INTO users (id, email, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, 'admin', ?, ?)"
  )
    .bind(id, email, pwHash, now, now)
    .run();

  return c.json({ ok: true, user: { id, email, role: "admin" } }, 201);
});

export default auth;
