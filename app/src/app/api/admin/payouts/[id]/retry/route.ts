import { requireApiRole } from "@/lib/auth/session";
import { ok, withErrors } from "@/lib/http/route";
import { retryDisbursement } from "@/lib/payments/retry";

/** An administrator retries a payout that failed definitely. The worker sends it. */
export const POST = withErrors<{ id: string }>("POST /api/admin/payouts/[id]/retry", async (_request, context) => {
  const admin = await requireApiRole("admin");
  const { id } = await context.params;
  const retried = await retryDisbursement({ disbursementId: id, actorId: admin.id });
  return ok({ disbursementId: retried.id, status: retried.status, generation: retried.generation });
});
