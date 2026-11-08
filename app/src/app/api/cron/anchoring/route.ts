import { runDueAnchoring } from "@/lib/anchoring/queue";
import { requireCronSecret } from "@/lib/http/cron";
import { ok, withErrors } from "@/lib/http/route";

/**
 * Works the anchoring queue, for a hosted cron service: POST with
 * "Authorization: Bearer <CRON_SECRET>". Disabled (404) when CRON_SECRET is
 * not set. `npm run scheduler` does the same on a server of your own.
 */
export const POST = withErrors("POST /api/cron/anchoring", async (request) => {
  requireCronSecret(request);
  return ok({ summary: await runDueAnchoring(new Date()) });
});
