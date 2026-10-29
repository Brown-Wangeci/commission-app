/**
 * Runs once when the Next.js server starts. Refuses to serve against a
 * database that is not UTF8 (issue #45): the server prints why and how to fix
 * it, then exits. A database that cannot be reached at start is not treated
 * as wrongly encoded; /api/health reports it instead.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { prisma } = await import("@/lib/db");
  const { assertUtf8Database, DatabaseEncodingError } = await import("@/lib/db-encoding");
  try {
    await assertUtf8Database(prisma);
  } catch (error) {
    if (error instanceof DatabaseEncodingError) {
      console.error(`\n[ledgerfield] Refusing to start.\n[ledgerfield] ${error.message}\n`);
      process.exit(1);
    }
    console.warn("[ledgerfield] Could not check the database encoding at start:", error instanceof Error ? error.message : error);
  }
}
