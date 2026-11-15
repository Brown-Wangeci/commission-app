import { requireCronSecret } from "@/lib/http/cron";
import { ok, withErrors } from "@/lib/http/route";
import { runDueScoringJobs } from "@/lib/scoring/runner";
import { requestDeadline } from "@/lib/time-budget";

/** Vercel Hobby's function limit with Fluid Compute (Vercel docs). The run itself stops at CRON_TIME_BUDGET_SECONDS. */
export const maxDuration = 300;

/**
 * For a hosted cron service: POST with "Authorization: Bearer <CRON_SECRET>".
 * Disabled (404) when CRON_SECRET is not set. Jobs that would not finish
 * inside the time budget are left due and counted as deferred.
 */
export const POST = withErrors("POST /api/cron/scoring", async (request) => {
  requireCronSecret(request);
  const deadline = requestDeadline();
  return ok({ summary: await runDueScoringJobs(new Date(), 50, deadline) });
});
