import { prisma } from "@/lib/db";

/** Tables that hold static reference data and survive a reset. */
const REFERENCE_TABLES = new Set(["ActivationTransitionRule", "_prisma_migrations"]);

/**
 * Empties every data table. TRUNCATE does not fire row-level UPDATE or DELETE
 * triggers, so it works on the append-only tables too.
 */
export async function resetDatabase(): Promise<void> {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
  const tables = rows
    .map((row) => row.tablename)
    .filter((name) => !REFERENCE_TABLES.has(name))
    .map((name) => `"${name}"`);
  if (tables.length > 0) {
    await prisma.$executeRawUnsafe(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
  }
}
