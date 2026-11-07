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

/**
 * Fixed fakes for every M-Pesa setting. They replace anything in the shell or
 * a .env file, so the suite can never use real credentials, and the base URL
 * is a closed local port, so a test that forgets its mock fails instead of
 * reaching Daraja. Tests that need Daraja point MPESA_BASE_URL at the mock in
 * tests/helpers/fake-daraja.ts.
 */
const FAKE_MPESA = {
  MPESA_ENV: "sandbox",
  MPESA_BASE_URL: "http://127.0.0.1:9",
  MPESA_CONSUMER_KEY: "test-consumer-key",
  MPESA_CONSUMER_SECRET: "test-consumer-secret",
  MPESA_STK_SHORTCODE: "174379",
  MPESA_STK_PASSKEY: "test-stk-passkey",
  MPESA_B2C_SHORTCODE: "600000",
  MPESA_B2C_INITIATOR_NAME: "test-initiator",
  MPESA_B2C_SECURITY_CREDENTIAL: "test-security-credential",
  MPESA_CALLBACK_BASE_URL: "https://callbacks.test",
  MPESA_CAPTURE_DIR: "",
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const baseUrl = env.TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? "";
  const runUrl = process.env.LEDGERFIELD_RUN_DB_URL ?? (baseUrl ? throwawayDatabaseUrl(baseUrl) : "");
  process.env.LEDGERFIELD_RUN_DB_URL = runUrl;
  return {
    resolve: {
      alias: { "@": path.resolve(__dirname, "src") },
    },
    // tsconfig keeps JSX for Next to compile; tests that render components need it compiled here.
    esbuild: { jsx: "automatic" },
    test: {
      environment: "node",
      include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
      globalSetup: ["tests/global-setup.ts"],
      fileParallelism: false,
      testTimeout: 60000,
      hookTimeout: 180000,
      env: {
        ...env,
        DATABASE_URL: runUrl,
        EVIDENCE_STORAGE_DIR: "storage/test-evidence",
        ...FAKE_MPESA,
      },
    },
  };
});
