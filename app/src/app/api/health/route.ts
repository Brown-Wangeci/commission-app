import { prisma } from "@/lib/db";
import { config } from "@/lib/config";

/**
 * For hosting health checks. Reports whether the database answers and
 * whether the scoring service reports its models loaded. Returns 200 when
 * the app can serve requests (database up), 503 otherwise; a scoring
 * service that is down is reported but does not fail the check, because the
 * app handles that by routing to review.
 */
async function database(): Promise<"ok" | "unavailable"> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return "ok";
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
