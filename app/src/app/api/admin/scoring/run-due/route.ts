import { requireApiRole } from "@/lib/auth/session";
import { ok, withErrors } from "@/lib/http/route";
import { runDueScoringJobs } from "@/lib/scoring/runner";
import { requestDeadline } from "@/lib/time-budget";

/** Vercel Hobby's function limit with Fluid Compute (Vercel docs). The run itself stops at CRON_TIME_BUDGET_SECONDS. */
export const maxDuration = 300;

/** Manual trigger for the scheduled path: run every scoring job that is due now, within the time budget. */
export const POST = withErrors("POST /api/admin/scoring/run-due", async () => {
  await requireApiRole("admin");
  const deadline = requestDeadline();
  return ok({ summary: await runDueScoringJobs(new Date(), 50, deadline) });
});
