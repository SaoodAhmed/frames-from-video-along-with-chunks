import { SELF, env } from "cloudflare:test";
import migration0001 from "../../migrations/0001_initial.sql?raw";
import migration0002 from "../../migrations/0002_indexes.sql?raw";

const BASE = "https://frameforge.test";

/** Miniflare's D1.exec() truncates at newlines; strip comments, split, flatten. */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** Reset schema (D1 is isolated per test file, so run once in beforeAll). */
export async function applyMigrations(): Promise<void> {
  for (const sql of [migration0001, migration0002]) {
    for (const stmt of statements(sql)) {
      await env.DB.exec(stmt);
    }
  }
}

export function api(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(BASE + path, init);
}

export function auth(token: string): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${token}` };
}

/** Type-safe `Response.json()` (workers-types v5 types it as `unknown`). */
export async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export async function register(
  email: string,
  password = "Password123!"
): Promise<{ token: string; user: { id: string; email: string; role: string } }> {
  const res = await api("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`register(${email}) -> ${res.status} ${await res.text()}`);
  return res.json();
}

export async function login(email: string, password = "Password123!"): Promise<Response> {
  return api("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

export async function setupAdmin(
  setupToken: string,
  email: string,
  password = "Password123!"
): Promise<Response> {
  return api("/api/auth/setup-admin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupToken, email, password }),
  });
}

export async function createUpload(
  token: string,
  filename = "clip.mp4",
  size = 250_000_000,
  mimeType = "video/mp4"
): Promise<{ res: Response; body: any }> {
  const res = await api("/api/uploads/create", {
    method: "POST",
    headers: auth(token),
    body: JSON.stringify({ filename, size, mimeType }),
  });
  const body = res.ok ? await res.json() : null;
  return { res, body };
}

/**
 * Drive the multipart upload against the in-test R2 instance to produce real
 * part ETags, then tell the Worker to complete it — mirrors the browser flow.
 * (The API route performs the final complete(), so we only upload parts here.)
 */
export async function completeUploadViaR2(
  token: string,
  input: { jobId: string; uploadId: string; r2Key: string; partCount: number }
): Promise<Response> {
  const mpu = await env.R2.resumeMultipartUpload(input.r2Key, input.uploadId);
  const parts: { partNumber: number; etag: string }[] = [];
  // R2 requires every non-last part to be >= 5 MB.
  const partBody = new Uint8Array(5 * 1024 * 1024).fill(1);
  for (let i = 1; i <= input.partCount; i++) {
    const up = await mpu.uploadPart(i, partBody);
    parts.push({ partNumber: i, etag: up.etag });
  }

  return api("/api/uploads/complete", {
    method: "POST",
    headers: auth(token),
    body: JSON.stringify({ jobId: input.jobId, uploadId: input.uploadId, parts }),
  });
}

let emailCounter = 0;
/** Unique email so tests stay independent regardless of storage isolation. */
export function uniqueEmail(prefix = "user"): string {
  emailCounter += 1;
  return `${prefix}${emailCounter}-${Date.now()}@test.dev`;
}

/** Insert a frame row + corresponding full/thumb R2 objects for a job. */
export async function insertFrame(
  job: { id: string; user_id: string },
  frameNumber: number,
  sourceFrameNumber: number
): Promise<{ id: string; r2_key: string }> {
  const id = crypto.randomUUID();
  const fullKey = `users/${job.user_id}/jobs/${job.id}/frames/full/frame_${String(frameNumber).padStart(4, "0")}.jpg`;
  const thumbKey = fullKey.replace("/frames/full/", "/frames/thumbs/");

  await env.R2.put(fullKey, "FULL".repeat(256));
  await env.R2.put(thumbKey, "THUMB".repeat(128));

  await env.DB.prepare(
    `INSERT INTO frames (id, job_id, frame_number, source_frame_number, timestamp, r2_key, width, height, deleted, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  )
    .bind(id, job.id, frameNumber, sourceFrameNumber, frameNumber / 30, fullKey, 1920, 1080, new Date().toISOString())
    .run();

  return { id, r2_key: fullKey };
}
