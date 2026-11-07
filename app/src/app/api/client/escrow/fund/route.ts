import { z } from "zod";
import { clientFor } from "@/lib/auth/actors";
import { requireApiRole } from "@/lib/auth/session";
import { ok, readJson, withErrors } from "@/lib/http/route";
import { startFunding } from "@/lib/payments/funding";
import { centsSchema, kenyanMsisdnSchema } from "@/lib/validation";

const bodySchema = z.object({ amountCents: centsSchema("The deposit", 1), payerMsisdn: kenyanMsisdnSchema });

/**
 * Asks M-Pesa to prompt the payer's phone (FR-06). This moves no money: the
 * balance changes only when a verified callback confirms the payment, so the
 * answer here is 202 and the attempt, never a new balance.
 */
export const POST = withErrors("POST /api/client/escrow/fund", async (request) => {
  const user = await requireApiRole("client");
  const client = await clientFor(user);
  const { amountCents, payerMsisdn } = await readJson(request, bodySchema);
  const attempt = await startFunding({ clientId: client.id, actorId: user.id, amountCents, payerMsisdn });
  return ok({ attemptId: attempt.id, status: attempt.status, amountCents: attempt.amountCents, failureReason: attempt.failureReason }, 202);
});
