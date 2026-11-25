import { requireCronSecret } from "@/lib/http/cron";
import { ok, withErrors } from "@/lib/http/route";
import { runRetention } from "@/lib/retention/anonymise";
import { requestDeadline } from "@/lib/time-budget";

/** Vercel Hobby's function limit with Fluid Compute (Vercel docs). The run itself stops at CRON_TIME_BUDGET_SECONDS. */
export const maxDuration = 300;

/**
 * DR-11. For a hosted cron service: POST with "Authorization: Bearer
 * <CRON_SECRET>". Disabled (404) when CRON_SECRET is not set. Submissions
 * that would not finish inside the time budget are left for the next run.
 */
export const POST = withErrors("POST /api/cron/retention", async (request) => {
  requireCronSecret(request);
  return ok({ summary: await runRetention(new Date(), requestDeadline()) });
});
