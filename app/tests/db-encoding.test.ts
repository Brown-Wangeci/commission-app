import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { assertUtf8Database, DatabaseEncodingError, databaseEncoding } from "@/lib/db-encoding";

/**
 * Issue #45: the app refuses a database that is not UTF8, and says how to
 * make one. Checked against the test run's own database (UTF8) and a
 * throwaway WIN1252 database created and dropped here; no other database is
 * touched.
 */
function urlFor(name: string): string {
  const url = new URL(process.env.DATABASE_URL ?? "");
  url.pathname = `/${name}`;
  return url.toString();
}

describe("database encoding check (issue #45)", () => {
  it("accepts the UTF8 database the suite runs on", async () => {
    expect((await databaseEncoding(prisma)).encoding).toBe("UTF8");
    await expect(assertUtf8Database(prisma)).resolves.toBeUndefined();
  });

  it("refuses a WIN1252 database, naming it and giving the instruction to make a UTF8 one", async () => {
    const name = `ledgerfield_enc_${Date.now()}_${process.pid}`;
    const maintenance = new PrismaClient({ datasourceUrl: urlFor("postgres") });
    await maintenance.$executeRawUnsafe(`CREATE DATABASE "${name}" WITH ENCODING 'WIN1252' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`);
    const win1252 = new PrismaClient({ datasourceUrl: urlFor(name) });
    try {
      const refusal = assertUtf8Database(win1252);
      await expect(refusal).rejects.toBeInstanceOf(DatabaseEncodingError);
      await expect(refusal).rejects.toThrow(`The database "${name}" is encoded WIN1252, not UTF8.`);
      await expect(refusal).rejects.toThrow("createdb -E UTF8 --template=template0");
    } finally {
      await win1252.$disconnect();
      await maintenance.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await maintenance.$disconnect();
    }
  });

  it("stores text from outside any single-byte code page", async () => {
    const [row] = await prisma.$queryRaw<{ text: string }[]>`SELECT ${"Mteja amesajiliwa − ✓ नमस्ते"}::text AS text`;
    expect(row.text).toBe("Mteja amesajiliwa − ✓ नमस्ते");
  });
});
