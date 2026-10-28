/**
 * Scoring scheduler. Every SCHEDULER_INTERVAL_SECONDS it asks the database
 * for scoring jobs that are due (T7 at hold-close, and retries after
 * failures) and runs them. Nothing is kept in memory between polls: the
 * schedule is the ScoringJob table, so stopping and restarting this process
 * neither loses nor repeats a call. Several copies may run at once; each job
 * is claimed by exactly one.
 *
 * Usage:
 *   npm run scheduler          poll until stopped
 *   npm run scheduler:once     run whatever is due now, then exit
 */
import { loadEnv } from "./load-env";

loadEnv();

async function main(): Promise<void> {
  const { config } = await import("../src/lib/config");
  const { runDueScoringJobs } = await import("../src/lib/scoring/runner");
  const { prisma } = await import("../src/lib/db");
  const once = process.argv.includes("--once");

  const tick = async (): Promise<void> => {
    const summary = await runDueScoringJobs(new Date());
    const ran = Object.values(summary).reduce((total, count) => total + count, 0);
    if (ran > 0 || once) console.log(`[scheduler] ${new Date().toISOString()} ${JSON.stringify(summary)}`);
  };

  if (once) {
    await tick();
    await prisma.$disconnect();
    return;
  }
  const intervalMs = config().SCHEDULER_INTERVAL_SECONDS * 1000;
  console.log(`[scheduler] polling every ${intervalMs / 1000}s`);
  for (;;) {
    try {
      await tick();
    } catch (error) {
      console.error("[scheduler] poll failed", error);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
