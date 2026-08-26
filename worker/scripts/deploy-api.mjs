#!/usr/bin/env node
/**
 * Deploy worker.js to Cloudflare Workers via the raw API, bypassing wrangler.
 *
 * Reads CLOUDFLARE_API_TOKEN from the repo .env (read-only) and uploads the
 * esbuild bundle as a pure script worker (no static-assets store).
 *
 * Usage: node worker/scripts/deploy-api.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ACCOUNT_ID = "a6e4f26a0af1d7591488bdd3f552a5e3";
const SCRIPT = "frameforge";

// Read CLOUDFLARE_API_TOKEN from .env (never modify it).
const envText = readFileSync(join(root, ".env"), "utf8");
const tokenLine = envText.split("\n").find((l) => l.startsWith("CLOUDFLARE_API_TOKEN="));
if (!tokenLine) throw new Error("CLOUDFLARE_API_TOKEN not found in .env");
const token = tokenLine.split("=").slice(1).join("=").trim().replace(/^"|"$/g, "");

const modulePath = join(root, ".deploy-tmp", "worker.js");
const workerSrc = readFileSync(modulePath, "utf8");

const metadata = {
  main_module: "worker.js",
  bindings: [
    { name: "DB", type: "d1", database_id: "81a5cf89-ac9c-4d0d-9c30-5829021f4215" },
    { name: "R2", type: "r2_bucket", bucket_name: "photos-from-video" },
    { name: "MAX_UPLOAD_SIZE", type: "plain_text", text: "2147483648" },
    { name: "MAX_FRAMES", type: "plain_text", text: "5000" },
    { name: "RATE_LIMIT_PER_MIN", type: "plain_text", text: "120" },
    { name: "GITHUB_OWNER", type: "plain_text", text: "SaoodAhmed" },
    { name: "GITHUB_REPO", type: "plain_text", text: "frames-from-video-along-with-chunks" },
  ],
  compatibility_date: "2025-01-01",
  compatibility_flags: ["nodejs_compat"],
};

const boundary = `ffapi_${Date.now()}`;
const CRLF = "\r\n";
const encoder = new TextEncoder();
const parts = [
  encoder.encode(
    `--${boundary}${CRLF}Content-Disposition: form-data; name="metadata"${CRLF}Content-Type: application/json${CRLF}${CRLF}${JSON.stringify(metadata)}${CRLF}`
  ),
  encoder.encode(
    `--${boundary}${CRLF}Content-Disposition: form-data; name="worker.js"; filename="worker.js"${CRLF}Content-Type: application/javascript+module${CRLF}${CRLF}`
  ),
  encoder.encode(workerSrc),
  encoder.encode(`${CRLF}--${boundary}--${CRLF}`),
];
const body = concat(parts);

const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT}`;
const res = await fetch(url, {
  method: "PUT",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/form-data; boundary=${boundary}` },
  body,
});
const out = await res.json();
console.log(`HTTP ${res.status} success=${out.success}`);
console.log(JSON.stringify(out, null, 2));

// Persist request body so we can re-verify later if needed.
writeFileSync(join(root, ".deploy-tmp", "final_body.bin"), body);
console.log(`Saved request body to .deploy-tmp/final_body.bin (${body.byteLength} bytes)`);

function concat(arrays) {
  const total = arrays.reduce((n, a) => n + a.byteLength, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    merged.set(a, off);
    off += a.byteLength;
  }
  return merged;
}
