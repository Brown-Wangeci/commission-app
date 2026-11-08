import { retryAnchor } from "@/lib/anchoring/queue";
import { requireApiRole } from "@/lib/auth/session";
import { conflict } from "@/lib/http/errors";
import { ok, withErrors } from "@/lib/http/route";

/** Sends a stalled anchoring batch round again, as the payout retry does for payouts. */
export const POST = withErrors<{ id: string }>("POST /api/admin/audit/anchors/[id]/retry", async (_request, context) => {
  const admin = await requireApiRole("admin");
  const { id } = await context.params;
  if (!(await retryAnchor(id, admin.id))) throw conflict("Only a stalled, unconfirmed batch can be retried.");
  return ok({ retried: true });
});
