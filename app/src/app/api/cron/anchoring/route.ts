import { runDueAnchoring } from "@/lib/anchoring/queue";
import { requireCronSecret } from "@/lib/http/cron";
import { ok, withErrors } from "@/lib/http/route";
import { requestDeadline } from "@/lib/time-budget";

/** Vercel Hobby's function limit with Fluid Compute (Vercel docs). The run itself stops at CRON_TIME_BUDGET_SECONDS. */
export const maxDuration = 300;

/**
 * Works the anchoring queue, for a hosted cron service: POST with
 * "Authorization: Bearer <CRON_SECRET>". Disabled (404) when CRON_SECRET is
 * not set. `npm run scheduler` does the same on a server of your own. The
 * receipt wait is cut to fit the time budget; an unseen receipt is picked up
 * by the next run.
 */
export const POST = withErrors("POST /api/cron/anchoring", async (request) => {
  requireCronSecret(request);
  const deadline = requestDeadline();
  return ok({ summary: await runDueAnchoring(new Date(), deadline) });
});
