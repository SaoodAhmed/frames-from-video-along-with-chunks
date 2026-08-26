import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: true,
    poolOptions: {
      workers: {
        singleWorker: false,
        wrangler: { configPath: "../wrangler.toml" },
        miniflare: {
          bindings: {
            // Test-only secrets. Real values live in Cloudflare secrets.
            AUTH_SECRET: "test-secret-for-tests",
            ADMIN_SETUP_TOKEN: "test-admin-token",
            R2_ACCESS_KEY_ID: "test-access-key",
            R2_SECRET_ACCESS_KEY: "test-secret-key",
            R2_ENDPOINT: "https://test.r2.cloudflarestorage.com",
            R2_BUCKET_NAME: "test-bucket",
            D1_DATABASE_ID: "test-db-id",
            RATE_LIMIT_PER_MIN: "100000",
          },
        },
      },
    },
  },
});
