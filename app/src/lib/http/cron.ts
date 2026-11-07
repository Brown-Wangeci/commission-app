import { timingSafeEqual } from "node:crypto";
import { config } from "@/lib/config";
import { ApiError, notFound } from "./errors";

function matches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** For a hosted cron service: "Authorization: Bearer <CRON_SECRET>". A 404 when CRON_SECRET is not set. */
export function requireCronSecret(request: Request): void {
  const secret = config().CRON_SECRET;
  if (!secret) throw notFound("Route");
  const header = request.headers.get("authorization") ?? "";
  if (!matches(header, `Bearer ${secret}`)) throw new ApiError(401, "unauthenticated", "Invalid cron secret.");
}
