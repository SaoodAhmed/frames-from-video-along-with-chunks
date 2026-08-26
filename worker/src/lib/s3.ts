/**
 * Minimal AWS Signature V4 presigner for Cloudflare R2 (S3-compatible).
 * Used to generate direct-to-R2 (presigned) upload/download URLs so that
 * large video/frame payloads never pass through the Worker request body.
 */

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function rfc3986(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

async function sha256(data: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", enc.encode(data));
}

async function hmac(key: BufferSource, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data));
}

/** Percent-encode each path segment (keeps slashes intact). */
export function encodeKey(key: string): string {
  return key
    .split("/")
    .map((seg) => rfc3986(seg))
    .join("/");
}

/** Virtual-host style host, e.g. `<bucket>.<account>.r2.cloudflarestorage.com`. */
export function getR2Host(endpoint: string, bucket: string): string {
  const host = new URL(endpoint).hostname;
  return `${bucket}.${host}`;
}

export interface PresignOptions {
  method: "GET" | "PUT" | "DELETE" | "POST";
  host: string;
  /** URL-encoded path WITHOUT leading bucket (e.g. `/users/1/jobs/2/original/a.mp4`). */
  path: string;
  query?: Record<string, string>;
  expiresInSec?: number;
}

/**
 * Build a presigned URL for the given S3/R2 operation.
 * Signing is computed over the exact canonical query string that R2 will
 * reconstruct, and the final URL uses identical percent-encoding.
 */
export async function presignUrl(
  accessKey: string,
  secretKey: string,
  region: string,
  service: string,
  opts: PresignOptions
): Promise<string> {
  const { method, host, path, query = {}, expiresInSec = 900 } = opts;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const signedHeaders = "host";
  const payloadHash = "UNSIGNED-PAYLOAD";

  const q: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKey}/${dateStamp}/${region}/${service}/aws4_request`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresInSec),
    "X-Amz-SignedHeaders": signedHeaders,
    ...query,
  };

  const canonicalQuery = Object.keys(q)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(q[k])}`)
    .join("&");

  const canonicalRequest = [
    method,
    path,
    canonicalQuery,
    `host:${host}`,
    "",
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    toHex(await sha256(canonicalRequest)),
  ].join("\n");

  const kDate = await hmac(enc.encode("AWS4" + secretKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = toHex(await hmac(kSigning, stringToSign));

  const finalQuery =
    canonicalQuery + "&X-Amz-Signature=" + rfc3986(signature);
  return `https://${host}${path}?${finalQuery}`;
}

/** Presigned GET URL for downloading an R2 object. */
export async function presignGet(
  accessKey: string,
  secretKey: string,
  region: string,
  host: string,
  key: string,
  expiresInSec = 900
): Promise<string> {
  return presignUrl(accessKey, secretKey, region, "s3", {
    method: "GET",
    host,
    path: "/" + encodeKey(key),
    expiresInSec,
  });
}

/** Presigned PUT URL for a single multipart part (direct browser -> R2). */
export async function presignPutPart(
  accessKey: string,
  secretKey: string,
  region: string,
  host: string,
  key: string,
  uploadId: string,
  partNumber: number,
  expiresInSec = 900
): Promise<string> {
  return presignUrl(accessKey, secretKey, region, "s3", {
    method: "PUT",
    host,
    path: "/" + encodeKey(key),
    query: { partNumber: String(partNumber), uploadId },
    expiresInSec,
  });
}
