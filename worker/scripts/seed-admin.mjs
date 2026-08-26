#!/usr/bin/env node
/**
 * Bootstrap the first admin against a running local/dev Worker.
 *
 * Usage:
 *   ADMIN_SETUP_TOKEN=... node worker/scripts/seed-admin.mjs \
 *     --email admin@example.com --password 'S3curePass!' [--url http://localhost:8787]
 *
 * Mirrors POST /api/auth/setup-admin. Returns the created user on success.
 */
import { argv, env } from "node:process";

function arg(name) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] : undefined;
}

const url = (arg("url") || "http://localhost:8787").replace(/\/$/, "");
const email = arg("email");
const password = arg("password");
const setupToken = env.ADMIN_SETUP_TOKEN;

if (!email || !password || !setupToken) {
  console.error(
    "Missing required input. Set ADMIN_SETUP_TOKEN and pass --email and --password."
  );
  process.exit(2);
}

const res = await fetch(`${url}/api/auth/setup-admin`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ setupToken, email, password }),
});
const body = await res.json();
if (!res.ok) {
  console.error(`setup-admin failed (${res.status}):`, body);
  process.exit(1);
}
console.log("Admin created:", body.user);
