import { requireCronSecret } from "@/lib/http/cron";
import { ok, withErrors } from "@/lib/http/route";
import { runDuePayments } from "@/lib/payments/worker";

/**
 * Runs the payment queue, for a hosted cron service: POST with
 * "Authorization: Bearer <CRON_SECRET>". Disabled (404) when CRON_SECRET is
 * not set. `npm run scheduler` does the same job on a server of your own.
 */
export const POST = withErrors("POST /api/cron/payments", async (request) => {
  requireCronSecret(request);
  return ok({ summary: await runDuePayments(new Date()) });
});
