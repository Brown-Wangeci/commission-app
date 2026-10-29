import type { Tx } from "@/lib/db";

/**
 * Ledgerfield needs a UTF8 database (issue #45). A database in a single-byte
 * encoding such as WIN1252 rejects any character outside its code page, so
 * evidence, notes and names typed by agents and clients could fail to save.
 * The app, the scheduler and the seed check the connected database at start
 * and refuse to run against one that is not UTF8. Nothing here changes a
 * database or a cluster.
 */
export const UTF8_INSTRUCTION =
  "Create a UTF8 database with `createdb -E UTF8 --template=template0 --locale=C <name>` " +
  "(or, for the local PostgreSQL from `npm run db:start`, `npm run db:create -- <name>`), " +
  "apply the migrations to it (`npm run db:migrate`), and point DATABASE_URL at it. See app/README.md, \"Database encoding\".";

export class DatabaseEncodingError extends Error {
  constructor(readonly database: string, readonly encoding: string) {
    super(`The database "${database}" is encoded ${encoding}, not UTF8. Ledgerfield needs a UTF8 database. ${UTF8_INSTRUCTION}`);
    this.name = "DatabaseEncodingError";
  }
}

export async function databaseEncoding(db: Tx): Promise<{ database: string; encoding: string }> {
  const [row] = await db.$queryRaw<{ database: string; encoding: string }[]>`
    SELECT current_database() AS database, pg_encoding_to_char(encoding) AS encoding
    FROM pg_database WHERE datname = current_database()`;
  return row;
}

/** Throws DatabaseEncodingError unless the connected database is UTF8. */
export async function assertUtf8Database(db: Tx): Promise<void> {
  const { database, encoding } = await databaseEncoding(db);
  if (encoding !== "UTF8") throw new DatabaseEncodingError(database, encoding);
}
