/**
 * Works the anchoring queue once, ignoring the interval, and prints the
 * result. For demonstrations and the evidence run; the scheduler does this on
 * its own every ANCHOR_INTERVAL_SECONDS.
 *
 * Usage: npm run anchor:once
 */
import { loadEnv } from "./load-env";

loadEnv();
process.env.ANCHOR_INTERVAL_SECONDS = "1";

async function main(): Promise<void> {
  const { runDueAnchoring } = await import("../src/lib/anchoring/queue");
  const { prisma } = await import("../src/lib/db");
  const summary = await runDueAnchoring(new Date(Date.now() + 2000));
  console.log(JSON.stringify(summary));
  const latest = await prisma.auditAnchor.findFirst({ orderBy: { toSequence: "desc" } });
  if (latest) {
    console.log(JSON.stringify({ ...latest, fromSequence: String(latest.fromSequence), toSequence: String(latest.toSequence), blockNumber: latest.blockNumber === null ? null : String(latest.blockNumber), searchFromBlock: latest.searchFromBlock === null ? null : String(latest.searchFromBlock) }, null, 2));
  }
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
