import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { databaseEncoding } from "@/lib/db-encoding";

/**
 * For hosting health checks. Reports whether the database answers, whether
 * it is UTF8 (issue #45), and whether the scoring service reports its models
 * loaded. Returns 200 when the app can serve requests (database up and
 * UTF8), 503 otherwise; a scoring service that is down is reported but does
 * not fail the check, because the app handles that by routing to review.
 */
async function database(): Promise<"ok" | "not_utf8" | "unavailable"> {
  try {
    return (await databaseEncoding(prisma)).encoding === "UTF8" ? "ok" : "not_utf8";
  } catch {
    return "unavailable";
  }
}

async function scoringService(): Promise<"ok" | "unavailable"> {
  try {
    const response = await fetch(new URL("/health", config().SCORING_SERVICE_URL), { signal: AbortSignal.timeout(3000) });
    const body = (await response.json()) as { loaded?: boolean };
    return response.ok && body.loaded ? "ok" : "unavailable";
  } catch {
    return "unavailable";
  }
}

export async function GET(): Promise<Response> {
  const [db, scoring] = await Promise.all([database(), scoringService()]);
  return Response.json({ status: db === "ok" ? "ok" : "unavailable", database: db, scoringService: scoring }, { status: db === "ok" ? 200 : 503 });
}
