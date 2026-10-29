import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { UTF8_DATABASE } from "../global-setup";

/**
 * A database of a test's own for checking a migration against data in the
 * shape before it: created as UTF8, brought up to just before the migration
 * under test, and dropped by `drop`.
 */
const MIGRATIONS = path.resolve(__dirname, "../../prisma/migrations");
const SCHEMA = path.resolve(__dirname, "../../prisma/schema.prisma");

function urlFor(name: string): string {
  const url = new URL(process.env.DATABASE_URL ?? "");
  url.pathname = `/${name}`;
  return url.toString();
}

async function maintenance<T>(work: (db: PrismaClient) => Promise<T>): Promise<T> {
  const db = new PrismaClient({ datasourceUrl: urlFor("postgres") });
  try {
    return await work(db);
  } finally {
    await db.$disconnect();
  }
}

function deploy(schema: string, url: string): void {
  execSync(`npx prisma migrate deploy --schema "${schema}"`, { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
}

export type MigrationDb = {
  db: PrismaClient;
  /** Applies every remaining migration, the one under test included. */
  migrate: () => void;
  drop: () => Promise<void>;
};

export async function databaseBefore(migration: string, label: string): Promise<MigrationDb> {
  const name = `ledgerfield_mig_${label}_${Date.now()}_${process.pid}`;
  const url = urlFor(name);
  await maintenance((db) => db.$executeRawUnsafe(`CREATE DATABASE "${name}" ${UTF8_DATABASE}`));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerfield-mig-"));
  fs.copyFileSync(SCHEMA, path.join(dir, "schema.prisma"));
  fs.mkdirSync(path.join(dir, "migrations"));
  for (const entry of fs.readdirSync(MIGRATIONS)) {
    if (entry >= migration && entry !== "migration_lock.toml") continue;
    fs.cpSync(path.join(MIGRATIONS, entry), path.join(dir, "migrations", entry), { recursive: true });
  }
  deploy(path.join(dir, "schema.prisma"), url);
  const db = new PrismaClient({ datasourceUrl: url });
  return {
    db,
    migrate: () => deploy(SCHEMA, url),
    drop: async () => {
      await db.$disconnect();
      await maintenance((m) => m.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
