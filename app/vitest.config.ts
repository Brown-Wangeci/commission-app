import path from "node:path";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

/**
 * Every test run gets its own empty database on the server named by
 * TEST_DATABASE_URL. tests/global-setup.ts creates it, applies the migrations
 * with `prisma migrate deploy`, and drops it afterwards. No existing database
 * is ever reset or truncated by the test suite.
 */
function throwawayDatabaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const name = `ledgerfield_run_${Date.now()}_${process.pid}`;
  url.pathname = `/${name}`;
  return url.toString();
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const baseUrl = env.TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? "";
  const runUrl = process.env.LEDGERFIELD_RUN_DB_URL ?? (baseUrl ? throwawayDatabaseUrl(baseUrl) : "");
  process.env.LEDGERFIELD_RUN_DB_URL = runUrl;
  return {
    resolve: {
      alias: { "@": path.resolve(__dirname, "src") },
    },
    test: {
      environment: "node",
      include: ["tests/**/*.test.ts"],
      globalSetup: ["tests/global-setup.ts"],
      fileParallelism: false,
      testTimeout: 60000,
      hookTimeout: 180000,
      env: {
        ...env,
        DATABASE_URL: runUrl,
        EVIDENCE_STORAGE_DIR: "storage/test-evidence",
      },
    },
  };
});
