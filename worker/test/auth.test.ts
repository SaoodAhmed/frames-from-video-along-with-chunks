import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, api, auth, json, login, register, setupAdmin, uniqueEmail } from "./helpers";

describe("auth", () => {
  beforeEach(async () => {
    await applyMigrations();
  });

  it("registers a user", async () => {
    const res = await api("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: uniqueEmail("reg"), password: "Password123!" }),
    });
    expect(res.status).toBe(201);
    const body = await json<any>(res);
    expect(body.token).toBeTruthy();
    expect(body.user.role).toBe("user");
  });

  it("rejects invalid email", async () => {
    const res = await api("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", password: "Password123!" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects short password", async () => {
    const res = await api("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: uniqueEmail("short"), password: "short" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects duplicate email", async () => {
    const email = uniqueEmail("dup");
    const res = await api("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "Password123!" }),
    });
    expect(res.status).toBe(201);
    const res2 = await api("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "Password123!" }),
    });
    expect(res2.status).toBe(409);
  });

  it("logs in with correct credentials", async () => {
    const email = uniqueEmail("login");
    await register(email);
    const res = await login(email);
    expect(res.status).toBe(200);
    const body = await json<any>(res);
    expect(body.token).toBeTruthy();
    expect(body.user.email).toBe(email);
  });

  it("rejects wrong password", async () => {
    const email = uniqueEmail("wrongpw");
    await register(email);
    const res = await login(email, "WrongPassword1!");
    expect(res.status).toBe(401);
  });

  it("rejects unknown email", async () => {
    const res = await login(uniqueEmail("nobody"));
    expect(res.status).toBe(401);
  });

  it("returns the current user from /me", async () => {
    const { token, user } = await register(uniqueEmail("me"));
    const res = await api("/api/auth/me", { headers: auth(token) });
    expect(res.status).toBe(200);
    const body = await json<any>(res);
    expect(body.user.sub).toBe(user.id);
  });

  it("rejects /me without a token", async () => {
    const res = await api("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("bootstraps the first admin with the setup token", async () => {
    const res = await setupAdmin("test-admin-token", uniqueEmail("admin"));
    expect(res.status).toBe(201);
    const body = await json<any>(res);
    expect(body.user.role).toBe("admin");
  });

  it("rejects a second admin bootstrap", async () => {
    expect((await setupAdmin("test-admin-token", uniqueEmail("adm1"))).status).toBe(201);
    const res = await setupAdmin("test-admin-token", uniqueEmail("adm2"));
    expect(res.status).toBe(409);
  });

  it("rejects setup-admin with the wrong token", async () => {
    const res = await setupAdmin("wrong-token", uniqueEmail("adm3"));
    expect(res.status).toBe(401);
  });

  it("lets admin hit admin routes but denies users (403)", async () => {
    const adminEmail = uniqueEmail("adminroute");
    await setupAdmin("test-admin-token", adminEmail);
    const { token: adminToken } = await json<any>(await login(adminEmail));
    expect((await api("/api/admin/stats", { headers: auth(adminToken) })).status).toBe(200);

    const { token: userToken } = await register(uniqueEmail("plainuser"));
    expect((await api("/api/admin/stats", { headers: auth(userToken) })).status).toBe(403);
  });

  it("rejects admin routes when unauthenticated (401)", async () => {
    const res = await api("/api/admin/stats");
    expect(res.status).toBe(401);
  });
});
