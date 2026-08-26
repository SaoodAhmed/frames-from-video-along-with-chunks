import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  applyMigrations,
  api,
  auth,
  completeUploadViaR2,
  createUpload,
  json,
  login,
  register,
  setupAdmin,
  uniqueEmail,
} from "./helpers";

describe("uploads", () => {
  let token: string;

  beforeEach(async () => {
    await applyMigrations();
    token = (await register(uniqueEmail("uploader"))).token;
  });

  it("requires authentication", async () => {
    const { res } = await createUpload("");
    expect(res.status).toBe(401);
  });

  it("creates a multipart upload with presigned part URLs", async () => {
    const size = 250_000_000; // 2.5 parts of 100 MB
    const { res, body } = await createUpload(token, "big.mp4", size);
    expect(res.status).toBe(201);
    expect(body.jobId).toBeTruthy();
    expect(body.uploadId).toBeTruthy();
    expect(body.chunkSize).toBe(100 * 1024 * 1024);
    expect(body.partUrls.length).toBe(3);
    for (const p of body.partUrls) {
      expect(p.partNumber).toBeGreaterThan(0);
      expect(p.url).toContain("X-Amz-Signature=");
      expect(p.url).toContain("uploadId=");
    }
    const job = await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(body.jobId).first<{ status: string }>();
    expect(job?.status).toBe("uploaded");
  });

  it("rejects files above the size limit", async () => {
    const { res } = await createUpload(token, "huge.mp4", 3_000_000_000);
    expect(res.status).toBe(413);
  });

  it("rejects unsupported video types", async () => {
    const { res } = await createUpload(token, "x.exe", 1000, "application/octet-stream");
    expect(res.status).toBe(415);
  });

  it("completes an upload end-to-end", async () => {
    const { body } = await createUpload(token, "done.mp4", 250_000_000);
    const res = await completeUploadViaR2(token, {
      jobId: body.jobId,
      uploadId: body.uploadId,
      r2Key: body.r2Key,
      partCount: body.partUrls.length,
    });
    expect(res.status).toBe(200);
    const done = await json<any>(res);
    expect(done.ok).toBe(true);
    const head = await env.R2.head(body.r2Key);
    expect(head).toBeTruthy();
  });

  it("404s when completing an unknown job", async () => {
    const res = await api("/api/uploads/complete", {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ jobId: crypto.randomUUID(), uploadId: "u", parts: [{ partNumber: 1, etag: "e" }] }),
    });
    expect(res.status).toBe(404);
  });

  it("409s when completing a job not in uploaded state", async () => {
    const { body } = await createUpload(token, "state.mp4", 1000);
    await env.DB.prepare("UPDATE jobs SET status = 'queued' WHERE id = ?").bind(body.jobId).run();
    const res = await api("/api/uploads/complete", {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ jobId: body.jobId, uploadId: body.uploadId, parts: [{ partNumber: 1, etag: "e" }] }),
    });
    expect(res.status).toBe(409);
  });

  it("owner can delete an un-processed upload", async () => {
    const { body } = await createUpload(token, "delete.mp4", 1000);
    const res = await api(`/api/uploads/${body.jobId}`, {
      method: "DELETE",
      headers: auth(token),
      body: JSON.stringify({ uploadId: body.uploadId }),
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT id FROM jobs WHERE id = ?").bind(body.jobId).first();
    expect(row).toBeNull();
  });

  it("forbids deleting another user's upload", async () => {
    const { body } = await createUpload(token, "theirs.mp4", 1000);
    const other = await register(uniqueEmail("other"));
    const res = await api(`/api/uploads/${body.jobId}`, {
      method: "DELETE",
      headers: auth(other.token),
      body: JSON.stringify({ uploadId: body.uploadId }),
    });
    expect(res.status).toBe(403);
  });

  it("allows an admin to delete any user's upload", async () => {
    const { body } = await createUpload(token, "admindelete.mp4", 1000);
    const adminEmail = uniqueEmail("admindelete");
    await setupAdmin("test-admin-token", adminEmail);
    const { token: adminToken } = await json<any>(await login(adminEmail));
    const res = await api(`/api/uploads/${body.jobId}`, {
      method: "DELETE",
      headers: auth(adminToken),
      body: JSON.stringify({ uploadId: body.uploadId }),
    });
    expect(res.status).toBe(200);
  });
});
