import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  applyMigrations,
  api,
  auth,
  completeUploadViaR2,
  createUpload,
  insertFrame,
  json,
  login,
  register,
  setupAdmin,
  uniqueEmail,
} from "./helpers";

describe("jobs (admin-driven processing)", () => {
  let userToken: string;
  let userId: string;
  let adminToken: string;

  beforeEach(async () => {
    await applyMigrations();
    const u = await register(uniqueEmail("jobowner"));
    userToken = u.token;
    userId = u.user.id;
    const adminEmail = uniqueEmail("jobsadmin");
    await setupAdmin("test-admin-token", adminEmail);
    adminToken = (await json<any>(await login(adminEmail))).token;
  });

  /** Fresh 'uploaded' job owned by the test user. */
  async function makeUploadedJob(): Promise<{ jobId: string; r2Key: string }> {
    const { body } = await createUpload(userToken, "clip.mp4", 100_000_000);
    const res = await completeUploadViaR2(userToken, {
      jobId: body.jobId,
      uploadId: body.uploadId,
      r2Key: body.r2Key,
      partCount: body.partUrls.length,
    });
    expect(res.status).toBe(200);
    return { jobId: body.jobId, r2Key: body.r2Key };
  }

  it("forbids a regular user from starting processing", async () => {
    const { jobId } = await makeUploadedJob();
    const res = await api(`/api/jobs/${jobId}/process`, {
      method: "POST",
      headers: auth(userToken),
      body: JSON.stringify({ mode: "1 fps" }),
    });
    expect(res.status).toBe(403);
  });

  it("404s processing an unknown job", async () => {
    const res = await api(`/api/jobs/${crypto.randomUUID()}/process`, {
      method: "POST",
      headers: auth(adminToken),
      body: JSON.stringify({ mode: "1 fps" }),
    });
    expect(res.status).toBe(404);
  });

  it("maps the Smart Scene preset to the -1 sentinel", async () => {
    const { jobId } = await makeUploadedJob();
    const res = await api(`/api/jobs/${jobId}/process`, {
      method: "POST",
      headers: auth(adminToken),
      body: JSON.stringify({ mode: "Smart Scene", sceneThreshold: 40 }),
    });
    expect(res.status).toBe(200);
    const { job } = await json<any>(res);
    expect(job.status).toBe("queued");
    expect(job.extraction_mode).toBe("smart_scene");
    expect(job.extraction_fps).toBe(-1);
    expect(job.scene_threshold).toBe(40);
  });

  it("maps Every Frame to -2 and custom FPS to its literal value", async () => {
    const a = await makeUploadedJob();
    const r1 = await api(`/api/jobs/${a.jobId}/process`, {
      method: "POST",
      headers: auth(adminToken),
      body: JSON.stringify({ mode: "Every Frame" }),
    });
    expect((await json<any>(r1)).job.extraction_fps).toBe(-2);

    const b = await makeUploadedJob();
    const r2 = await api(`/api/jobs/${b.jobId}/process`, {
      method: "POST",
      headers: auth(adminToken),
      body: JSON.stringify({ mode: "Custom FPS", fps: 7.5, sharpness: 1.2 }),
    });
    const job2 = await json<any>(r2);
    expect(job2.job.extraction_fps).toBe(7.5);
    expect(job2.job.sharpness).toBe(1.2);
  });

  it("rejects an out-of-range custom FPS", async () => {
    const { jobId } = await makeUploadedJob();
    const res = await api(`/api/jobs/${jobId}/process`, {
      method: "POST",
      headers: auth(adminToken),
      body: JSON.stringify({ mode: "Custom FPS", fps: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown preset", async () => {
    const { jobId } = await makeUploadedJob();
    const res = await api(`/api/jobs/${jobId}/process`, {
      method: "POST",
      headers: auth(adminToken),
      body: JSON.stringify({ mode: "Nonsense" }),
    });
    expect(res.status).toBe(400);
  });

  it("409s processing a job that is already queued", async () => {
    const { jobId } = await makeUploadedJob();
    await api(`/api/jobs/${jobId}/process`, {
      method: "POST",
      headers: auth(adminToken),
      body: JSON.stringify({ mode: "1 fps" }),
    });
    const res = await api(`/api/jobs/${jobId}/process`, {
      method: "POST",
      headers: auth(adminToken),
      body: JSON.stringify({ mode: "1 fps" }),
    });
    expect(res.status).toBe(409);
  });

  it("cancels a queued job once, then refuses the second cancel", async () => {
    const { jobId } = await makeUploadedJob();
    await api(`/api/jobs/${jobId}/process`, {
      method: "POST",
      headers: auth(adminToken),
      body: JSON.stringify({ mode: "1 fps" }),
    });
    const c1 = await api(`/api/jobs/${jobId}/cancel`, { method: "POST", headers: auth(adminToken) });
    expect(c1.status).toBe(200);
    expect((await json<any>(c1)).job.status).toBe("cancelled");

    const c2 = await api(`/api/jobs/${jobId}/cancel`, { method: "POST", headers: auth(adminToken) });
    expect(c2.status).toBe(409);
  });

  it("retries a failed job back to queued", async () => {
    const { jobId } = await makeUploadedJob();
    await env.DB.prepare("UPDATE jobs SET status = 'failed', error_message = 'boom' WHERE id = ?").bind(jobId).run();
    const res = await api(`/api/jobs/${jobId}/retry`, { method: "POST", headers: auth(adminToken) });
    expect(res.status).toBe(200);
    expect((await json<any>(res)).job.status).toBe("queued");
  });

  it("lists frames with presigned URLs and pagination", async () => {
    const { jobId } = await makeUploadedJob();
    await insertFrame({ id: jobId, user_id: userId }, 1, 30);
    await insertFrame({ id: jobId, user_id: userId }, 2, 60);
    await insertFrame({ id: jobId, user_id: userId }, 3, 90);

    const res = await api(`/api/jobs/${jobId}/frames`, { headers: auth(adminToken) });
    expect(res.status).toBe(200);
    const body = await json<any>(res);
    expect(body.total).toBe(3);
    expect(body.frames.length).toBe(3);
    expect(body.frames[0].thumbUrl).toContain("test-bucket.test.r2.cloudflarestorage.com");
    expect(body.frames[0].thumbUrl).toContain("X-Amz-Signature=");
    expect(body.frames[0].fullUrl).toContain("/frames/full/frame_0001.jpg");

    const page2 = await api(`/api/jobs/${jobId}/frames?page=2&perPage=2`, { headers: auth(adminToken) });
    const p2 = await json<any>(page2);
    expect(p2.frames.length).toBe(1);
    expect(p2.frames[0].frame_number).toBe(3);
  });

  it("soft-deletes frames and removes their R2 objects", async () => {
    const { jobId } = await makeUploadedJob();
    const f1 = await insertFrame({ id: jobId, user_id: userId }, 1, 0);
    const f2 = await insertFrame({ id: jobId, user_id: userId }, 2, 30);

    const res = await api(`/api/jobs/${jobId}/frames/delete`, {
      method: "POST",
      headers: auth(adminToken),
      body: JSON.stringify({ frameIds: [f2.id] }),
    });
    expect(res.status).toBe(200);
    expect((await json<any>(res)).deleted).toBe(1);

    const list = await api(`/api/jobs/${jobId}/frames`, { headers: auth(adminToken) });
    const body = await json<any>(list);
    expect(body.total).toBe(1);
    expect(body.frames.map((f: any) => f.id)).toEqual([f1.id]);

    expect(await env.R2.head(f2.r2_key)).toBeNull();
    expect(await env.R2.head(f2.r2_key.replace("/frames/full/", "/frames/thumbs/"))).toBeNull();
    expect(await env.R2.head(f1.r2_key)).toBeTruthy();
  });

  it("rejects frame deletion with no frameIds", async () => {
    const { jobId } = await makeUploadedJob();
    const res = await api(`/api/jobs/${jobId}/frames/delete`, {
      method: "POST",
      headers: auth(adminToken),
      body: JSON.stringify({ frameIds: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("creates an 'all' export and reports its status", async () => {
    const { jobId } = await makeUploadedJob();
    const res = await api(`/api/jobs/${jobId}/export`, {
      method: "POST",
      headers: auth(adminToken),
      body: JSON.stringify({ type: "all" }),
    });
    expect(res.status).toBe(201);
    const { exportId } = await json<any>(res);
    expect(exportId).toBeTruthy();

    const st = await api(`/api/jobs/exports/${exportId}`, { headers: auth(adminToken) });
    expect(st.status).toBe(200);
    const exp = await json<any>(st);
    expect(exp.status).toBe("queued");
    expect(exp.export_type).toBe("all");
  });

  it("requires frameIds for a selected export", async () => {
    const { jobId } = await makeUploadedJob();
    const res = await api(`/api/jobs/${jobId}/export`, {
      method: "POST",
      headers: auth(adminToken),
      body: JSON.stringify({ type: "selected", frameIds: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("creates a selected export with frameIds", async () => {
    const { jobId } = await makeUploadedJob();
    await insertFrame({ id: jobId, user_id: userId }, 1, 0);
    const res = await api(`/api/jobs/${jobId}/export`, {
      method: "POST",
      headers: auth(adminToken),
      body: JSON.stringify({ type: "selected", frameIds: [crypto.randomUUID()] }),
    });
    expect(res.status).toBe(201);
  });
});
