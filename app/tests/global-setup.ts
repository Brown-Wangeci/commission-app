import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

/**
 * Creates a brand-new database for this test run and applies every migration
 * to it with `prisma migrate deploy`. That is the check for issue #1: the
 * migrations apply cleanly to an empty database, from scratch, on every run.
 * The database is dropped when the run ends. It was created by this run, so
 * nothing else can be in it.
 */
function maintenanceUrl(runUrl: string): string {
  const url = new URL(runUrl);
  url.pathname = "/postgres";
  return url.toString();
}

function databaseName(runUrl: string): string {
  const name = new URL(runUrl).pathname.slice(1);
  if (!/^ledgerfield_run_\d+_\d+$/.test(name)) {
    throw new Error(`Refusing to manage unexpected test database name ${name}`);
  }
  return name;
}

async function withMaintenance<T>(runUrl: string, work: (db: PrismaClient) => Promise<T>): Promise<T> {
  const db = new PrismaClient({ datasourceUrl: maintenanceUrl(runUrl) });
  try {
    return await work(db);
  } finally {
    await db.$disconnect();
  }
}

export default async function setup(): Promise<() => Promise<void>> {
  const runUrl = process.env.LEDGERFIELD_RUN_DB_URL;
  if (!runUrl) throw new Error("TEST_DATABASE_URL is not set. Copy .env.example to .env.");
  const name = databaseName(runUrl);

  try {
    await withMaintenance(runUrl, (db) => db.$executeRawUnsafe(`CREATE DATABASE "${name}"`));
  } catch (error) {
    throw new Error(
      `Could not create test database ${name}. Is PostgreSQL running (npm run db:start)?\n${String(error)}`,
    );
  }
  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: runUrl },
    stdio: "pipe",
  });

  return async () => {
    await withMaintenance(runUrl, (db) =>
      db.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
    );
  };
}
