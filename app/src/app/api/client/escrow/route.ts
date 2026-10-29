import { clientFor } from "@/lib/auth/actors";
import { requireApiRole } from "@/lib/auth/session";
import { ok, withErrors } from "@/lib/http/route";
import { clientEscrowView } from "@/lib/jobs/jobs";

/**
 * The client's escrow: deposited, committed and available balance, and for
 * each job its commission per approved submission, its locked liability and
 * its unspent remainder. Every computed amount carries its derivation.
 */
export const GET = withErrors("GET /api/client/escrow", async () => {
  const client = await clientFor(await requireApiRole("client"));
  return ok(await clientEscrowView(client.id));
});
