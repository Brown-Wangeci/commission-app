import { requireApiRole } from "@/lib/auth/session";
import { ok, withErrors } from "@/lib/http/route";
import { runDueScoringJobs } from "@/lib/scoring/runner";

/** Manual trigger for the scheduled path: run every scoring job that is due now. */
export const POST = withErrors("POST /api/admin/scoring/run-due", async () => {
  await requireApiRole("admin");
  return ok({ summary: await runDueScoringJobs(new Date()) });
});
