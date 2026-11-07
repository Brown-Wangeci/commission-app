import { requireCronSecret } from "@/lib/http/cron";
import { ok, withErrors } from "@/lib/http/route";
import { runDueScoringJobs } from "@/lib/scoring/runner";

/**
 * For a hosted cron service: POST with "Authorization: Bearer <CRON_SECRET>".
 * Disabled (404) when CRON_SECRET is not set.
 */
export const POST = withErrors("POST /api/cron/scoring", async (request) => {
  requireCronSecret(request);
  return ok({ summary: await runDueScoringJobs(new Date()) });
});
