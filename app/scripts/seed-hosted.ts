/**
 * Seeds the hosted (Neon) database from a developer machine, using the
 * settings that let a remote seed finish. Every value comes from
 * app/.env.hosted (written by `vercel env pull .env.hosted
 * --environment=production`). No URL or secret is printed.
 *
 * - DATABASE_URL is the direct (unpooled) Neon URL, with connection_limit=1.
 *   From Nairobi a query to Frankfurt costs about 190 ms and the seed makes
 *   thousands. Two remote runs lost their connection after 27 to 29 minutes
 *   (P1017), once pooled and once direct. The run with a single connection
 *   completed. That one success supports the change but does not prove it.
 * - PRISMA_TRANSACTION_TIMEOUT_MS=30000: one T7 decision with its payout took
 *   5.2 s at that latency, past Prisma's 5 s default.
 *
 * It takes about 40 minutes. The local seed (npm run db:seed) takes about
 * half a minute. Evidence: docs/chapter5/evidence/hosted/seed/.
 *
 * Usage, from app/: node node_modules/tsx/dist/cli.mjs scripts/seed-hosted.ts
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

const APP_DIR = path.resolve(__dirname, "..");
const ENV_FILE = path.join(APP_DIR, ".env.hosted");

/** The hosted settings, with the database URL and timeout this seed needs. Refuses an incomplete pull. */
export function hostedSeedEnv(hosted: Record<string, string | undefined>): Record<string, string | undefined> {
  const direct = hosted.DATABASE_URL_UNPOOLED;
  const missing = ["DATABASE_URL_UNPOOLED", "BLOB_READ_WRITE_TOKEN", "SCORING_SERVICE_URL", "MSISDN_HASH_SALT"].filter((name) => !hosted[name]);
  if (missing.length > 0) throw new Error(`.env.hosted lacks ${missing.join(", ")}. Pull it again: vercel env pull .env.hosted --environment=production --yes`);
  if (hosted.VERCEL !== "1") throw new Error(".env.hosted is not a Vercel pull (VERCEL is not 1), so evidence would go to local disk instead of Blob.");
  if (direct!.includes("-pooler")) throw new Error("DATABASE_URL_UNPOOLED names the pooled host; expected the direct one.");
  const separator = direct!.includes("?") ? "&" : "?";
  return { ...hosted, DATABASE_URL: `${direct}${separator}connection_limit=1`, PRISMA_TRANSACTION_TIMEOUT_MS: "30000" };
}

function main(): void {
  if (!fs.existsSync(ENV_FILE)) throw new Error("app/.env.hosted not found. Run: vercel env pull .env.hosted --environment=production --yes");
  const env = { ...process.env, ...hostedSeedEnv(parseEnv(fs.readFileSync(ENV_FILE, "utf8"))) };
  console.log("[seed-hosted] seeding Neon over the direct URL, one connection, 30 s transaction timeout");
  const tsx = path.join(APP_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  const result = spawnSync(process.execPath, [tsx, "prisma/seed.ts"], { cwd: APP_DIR, env: env as NodeJS.ProcessEnv, stdio: "inherit" });
  process.exit(result.status ?? 1);
}

if (typeof require !== "undefined" && require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[seed-hosted] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
