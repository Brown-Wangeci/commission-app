/**
 * Runs the Prisma CLI with DATABASE_URL_UNPOOLED always set in the process
 * environment, so `directUrl` in schema.prisma resolves everywhere:
 *
 * - hosted (Neon): DATABASE_URL is the pooled URL and DATABASE_URL_UNPOOLED
 *   the direct one; both are given, and migrations use the direct one.
 * - local and CI: only DATABASE_URL is given; it is a direct connection
 *   already, so it is copied into DATABASE_URL_UNPOOLED.
 *
 * Setting it in the process environment, rather than leaving it to a .env
 * file, matters: Prisma never lets a .env file replace a variable that is
 * already set, so a stray DATABASE_URL_UNPOOLED in app/.env can never send a
 * migration to a different database from the one DATABASE_URL names.
 *
 * Usage: tsx scripts/prisma-env.ts migrate deploy
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { loadEnv } from "./load-env";

/** The environment a Prisma CLI call needs: DATABASE_URL_UNPOOLED defaults to DATABASE_URL. */
export function prismaEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not set. Copy .env.example to .env.");
  return { ...env, DATABASE_URL_UNPOOLED: env.DATABASE_URL_UNPOOLED || env.DATABASE_URL };
}

function main(): void {
  loadEnv();
  const cli = path.resolve(__dirname, "..", "node_modules", "prisma", "build", "index.js");
  const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { env: prismaEnv(process.env) as NodeJS.ProcessEnv, stdio: "inherit" });
  process.exit(result.status ?? 1);
}

// Imported by the test suite for prismaEnv(); run only as a script.
if (typeof require !== "undefined" && require.main === module) main();
