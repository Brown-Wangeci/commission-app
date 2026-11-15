import { requireCronSecret } from "@/lib/http/cron";
import { ok, withErrors } from "@/lib/http/route";
import { runDuePayments } from "@/lib/payments/worker";
import { requestDeadline } from "@/lib/time-budget";

/** Vercel Hobby's function limit with Fluid Compute (Vercel docs). The run itself stops at CRON_TIME_BUDGET_SECONDS. */
export const maxDuration = 300;

/**
 * Runs the payment queue, for a hosted cron service: POST with
 * "Authorization: Bearer <CRON_SECRET>". Disabled (404) when CRON_SECRET is
 * not set. `npm run scheduler` does the same job on a server of your own.
 * Instructions that would not finish inside the time budget wait for the next run.
 */
export const POST = withErrors("POST /api/cron/payments", async (request) => {
  requireCronSecret(request);
  const deadline = requestDeadline();
  return ok({ summary: await runDuePayments(new Date(), undefined, deadline) });
});
