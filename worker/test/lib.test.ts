import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/lib/password";
import { signToken, verifyToken } from "../src/lib/jwt";
import { encodeKey, getR2Host, presignGet, presignPutPart } from "../src/lib/s3";
import { canTransition } from "../src/types";

describe("password hashing (PBKDF2)", () => {
  it("round-trips and rejects wrong passwords", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("pbkdf2$100000$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  it("uses a unique salt per hash", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same", a)).toBe(true);
    expect(await verifyPassword("same", b)).toBe(true);
  });

  it("rejects malformed stored hashes", async () => {
    expect(await verifyPassword("x", "not-a-valid-hash")).toBe(false);
  });
});

describe("JWT (HS256)", () => {
  const secret = "unit-test-secret";

  it("signs and verifies a token", async () => {
    const token = await signToken({ sub: "u1", email: "x@test.dev", role: "user" }, secret);
    const payload = await verifyToken(token, secret);
    expect(payload?.sub).toBe("u1");
    expect(payload?.email).toBe("x@test.dev");
    expect(payload?.role).toBe("user");
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signToken({ sub: "u1" }, "other-secret");
    expect(await verifyToken(token, secret)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const token = await signToken({ sub: "u1", email: "a@b.c", role: "user" }, secret);
    const [h, , sig] = token.split(".");
    const forged = btoa(JSON.stringify({ sub: "u2", email: "hax@b.c", role: "admin" }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const tampered = `${h}.${forged}.${sig}`;
    expect(await verifyToken(tampered, secret)).toBeNull();
  });

  it("rejects expired tokens", async () => {
    const token = await signToken({ sub: "u1" }, secret, -10);
    expect(await verifyToken(token, secret)).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    expect(await verifyToken("garbage", secret)).toBeNull();
    expect(await verifyToken("a.b.c.d", secret)).toBeNull();
  });
});

describe("S3 presigning", () => {
  const endpoint = "https://test.r2.cloudflarestorage.com";
  const bucket = "photos-from-video";
  const key = "users/u1/jobs/j1/frames/full/frame_0001.jpg";

  it("builds a virtual-host URL", () => {
    expect(getR2Host(endpoint, bucket)).toBe("photos-from-video.test.r2.cloudflarestorage.com");
  });

  it("percent-encodes key segments, keeping slashes", () => {
    expect(encodeKey("a b/c!d.mp4")).toBe("a%20b/c%21d.mp4");
  });

  it("signs a GET URL with the required query params", async () => {
    const host = getR2Host(endpoint, bucket);
    const url = await presignGet("AK", "SK", "auto", host, key, 900);
    const u = new URL(url);
    expect(u.protocol).toBe("https:");
    expect(u.host).toBe(host);
    expect(u.pathname).toBe("/" + key);
    expect(u.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(u.searchParams.get("X-Amz-Credential")).toMatch(/^AK\/\d{8}\/auto\/s3\/aws4_request$/);
    const sig = u.searchParams.get("X-Amz-Signature");
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("signs a multipart part PUT with partNumber/uploadId", async () => {
    const host = getR2Host(endpoint, bucket);
    const url = await presignPutPart("AK", "SK", "auto", host, key, "up-123", 7, 900);
    const u = new URL(url);
    expect(u.searchParams.get("partNumber")).toBe("7");
    expect(u.searchParams.get("uploadId")).toBe("up-123");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(u.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("job state machine", () => {
  it("enforces the allowed transition table", () => {
    expect(canTransition("uploaded", "queued")).toBe(true);
    expect(canTransition("queued", "processing")).toBe(true);
    expect(canTransition("queued", "cancelled")).toBe(true);
    expect(canTransition("processing", "completed")).toBe(true);
    expect(canTransition("processing", "failed")).toBe(true);
    expect(canTransition("failed", "queued")).toBe(true);
    expect(canTransition("cancelled", "queued")).toBe(true);
    expect(canTransition("completed", "queued")).toBe(true);

    expect(canTransition("uploaded", "completed")).toBe(false);
    expect(canTransition("completed", "failed")).toBe(false);
    expect(canTransition("queued", "queued")).toBe(false);
    expect(canTransition("processing", "uploaded")).toBe(false);
  });
});
