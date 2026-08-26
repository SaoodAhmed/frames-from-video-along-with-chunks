import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, api, auth, completeUploadViaR2, createUpload, json, login, register, setupAdmin, uniqueEmail } from "./helpers";

describe("user isolation", () => {
  let alice: { token: string };
  let bob: { token: string };

  beforeEach(async () => {
    await applyMigrations();
    alice = await register(uniqueEmail("alice"));
    bob = await register(uniqueEmail("bob"));
  });

  async function aliceJob(): Promise<{ jobId: string; uploadId: string; r2Key: string }> {
    const { body } = await createUpload(alice.token, "alice.mp4", 100_000_000);
    const res = await completeUploadViaR2(alice.token, {
      jobId: body.jobId,
      uploadId: body.uploadId,
      r2Key: body.r2Key,
      partCount: body.partUrls.length,
    });
    expect(res.status).toBe(200);
    return { jobId: body.jobId, uploadId: body.uploadId, r2Key: body.r2Key };
  }

  it("hides Alice's job from Bob by ID", async () => {
    const { jobId } = await aliceJob();
    const res = await api(`/api/jobs/${jobId}`, { headers: auth(bob.token) });
    expect(res.status).toBe(404);
  });

  it("keeps Bob's /videos list free of Alice's jobs", async () => {
    await aliceJob();
    const res = await api("/api/videos", { headers: auth(bob.token) });
    expect(res.status).toBe(200);
    const { jobs } = await json<any>(res);
    expect(jobs).toHaveLength(0);
  });

  it("lets Alice see her own job", async () => {
    const { jobId } = await aliceJob();
    const res = await api(`/api/jobs/${jobId}`, { headers: auth(alice.token) });
    expect(res.status).toBe(200);
  });

  it("forbids Bob from deleting Alice's upload", async () => {
    const { jobId, uploadId } = await aliceJob();
    const res = await api(`/api/uploads/${jobId}`, {
      method: "DELETE",
      headers: auth(bob.token),
      body: JSON.stringify({ uploadId }),
    });
    expect(res.status).toBe(403);
  });

  it("lets an admin see all jobs", async () => {
    const adminEmail = uniqueEmail("iso_admin");
    await setupAdmin("test-admin-token", adminEmail);
    const { token } = await json<any>(await login(adminEmail));
    const { jobId } = await aliceJob();
    const res = await api(`/api/jobs/${jobId}`, { headers: auth(token) });
    expect(res.status).toBe(200);

    const all = await api("/api/admin/videos", { headers: auth(token) });
    expect(all.status).toBe(200);
    const { total } = await json<any>(all);
    expect(total).toBe(1);
  });
});
