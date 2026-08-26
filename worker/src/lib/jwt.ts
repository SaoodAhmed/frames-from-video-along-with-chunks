/**
 * Minimal HMAC-SHA256 JWT (HS256) using WebCrypto.
 * Payload shape: { sub, email, role, iat, exp }
 */

const enc = new TextEncoder();

function b64url(buf: ArrayBuffer | Uint8Array): string {
  let bin = "";
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded);
  let out = "";
  for (let i = 0; i < bin.length; i++) out += String.fromCharCode(bin.charCodeAt(i));
  return out;
}

async function hmacSha256(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64url(sig);
}

export async function signToken(
  payload: Record<string, unknown>,
  secret: string,
  expiresInSec = 7 * 24 * 60 * 60
): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(
    enc.encode(
      JSON.stringify({
        ...payload,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + expiresInSec,
      })
    )
  );
  const sig = await hmacSha256(secret, `${header}.${body}`);
  return `${header}.${body}.${sig}`;
}

export async function verifyToken(
  token: string,
  secret: string
): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const expected = await hmacSha256(secret, `${h}.${p}`);
  if (expected !== sig) return null;
  try {
    const payload = JSON.parse(unb64url(p));
    if (
      typeof payload !== "object" ||
      payload === null ||
      typeof payload.exp !== "number"
    )
      return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}
