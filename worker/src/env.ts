import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

export interface Env {
  DB: D1Database;
  R2: R2Bucket;
  ASSETS: Fetcher;
  AUTH_SECRET: string;
  ADMIN_SETUP_TOKEN: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_ENDPOINT: string;
  R2_BUCKET_NAME: string;
  D1_DATABASE_ID: string;
  MAX_UPLOAD_SIZE?: string;
  MAX_FRAMES?: string;
  RATE_LIMIT_PER_MIN?: string;
  /** Optional Modal processor webhook. If unset, the processor polls D1 instead. */
  MODAL_PROCESS_URL?: string;
  MODAL_TOKEN?: string;
  /** Shared token the extraction runner uses to call /api/processor/*. */
  PROCESSOR_TOKEN?: string;
  /** GitHub repo + PAT for the on-demand Actions runner (24/7 processing). */
  GITHUB_OWNER?: string;
  GITHUB_REPO?: string;
  GITHUB_PAT?: string;
}

export const S3_REGION = "auto";
export const S3_SERVICE = "s3";

export function maxUploadSize(env: Env): number {
  return parseInt(env.MAX_UPLOAD_SIZE || "2147483648", 10);
}

export function maxFrames(env: Env): number {
  return parseInt(env.MAX_FRAMES || "5000", 10);
}
