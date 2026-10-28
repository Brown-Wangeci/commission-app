import { timingSafeEqual } from "node:crypto";
import { config } from "@/lib/config";
import { ApiError, notFound } from "@/lib/http/errors";
import { ok, withErrors } from "@/lib/http/route";
import { runDueScoringJobs } from "@/lib/scoring/runner";

function matches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * For a hosted cron service: POST with "Authorization: Bearer <CRON_SECRET>".
 * Disabled (404) when CRON_SECRET is not set.
 */
export const POST = withErrors("POST /api/cron/scoring", async (request) => {
  const secret = config().CRON_SECRET;
  if (!secret) throw notFound("Route");
  const header = request.headers.get("authorization") ?? "";
  if (!matches(header, `Bearer ${secret}`)) throw new ApiError(401, "unauthenticated", "Invalid cron secret.");
  return ok({ summary: await runDueScoringJobs(new Date()) });
});
