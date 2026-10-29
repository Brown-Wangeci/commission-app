/**
 * Creates a new UTF8 database on the PostgreSQL server named by DATABASE_URL
 * (issue #45), for machines without the `createdb` client tool, such as one
 * using the local PostgreSQL from `npm run db:start`. Equivalent to
 * `createdb -E UTF8 --template=template0 --locale=C <name>`. It only ever
 * creates; it refuses a name that already exists and changes nothing else.
 *
 * Usage: npm run db:create -- <name>
 */
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "./load-env";

loadEnv();

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name || !/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error("Usage: npm run db:create -- <name>   (lower-case letters, digits and underscores)");
  }
  const url = new URL(process.env.DATABASE_URL ?? "");
  url.pathname = "/postgres";
  const db = new PrismaClient({ datasourceUrl: url.toString() });
  try {
    const existing = await db.$queryRaw<{ n: number }[]>`SELECT 1 AS n FROM pg_database WHERE datname = ${name}`;
    if (existing.length > 0) throw new Error(`A database named ${name} already exists; nothing was changed.`);
    await db.$executeRawUnsafe(`CREATE DATABASE "${name}" WITH ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`);
    url.pathname = `/${name}`;
    url.password = url.password ? "****" : "";
    console.log(`Created UTF8 database ${name}. Next: set DATABASE_URL to ${url.toString()} (with your password) and run npm run db:migrate.`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
