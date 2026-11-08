/**
 * Verifies the audit trail from the command line.
 *
 *   npm run audit:verify                       the whole hash chain (A3)
 *   npm run audit:verify -- <activationId>     one submission, against the chain (C2)
 *
 * Exits 0 when everything verifies, 1 otherwise, and prints the report as JSON.
 */
import { loadEnv } from "./load-env";

loadEnv();

async function main(): Promise<number> {
  const { prisma } = await import("../src/lib/db");
  const { verifyChain } = await import("../src/lib/audit/chain");
  const { verifyActivationAudit } = await import("../src/lib/audit/verify");
  const activationId = process.argv[2];
  const report = activationId ? await verifyActivationAudit(prisma, activationId) : await verifyChain(prisma);
  console.log(JSON.stringify(report, (_key, value) => (typeof value === "bigint" ? String(value) : value), 2));
  await prisma.$disconnect();
  const ok = "ok" in report ? report.ok : report.status === "verified";
  return ok ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
