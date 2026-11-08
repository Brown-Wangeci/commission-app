import { verifyChain } from "@/lib/audit/chain";
import { requireApiRole } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { ok, withErrors } from "@/lib/http/route";

/** Recomputes every event hash from its stored fields and checks every link (A3). */
export const POST = withErrors("POST /api/admin/audit/verify-chain", async () => {
  await requireApiRole("admin");
  return ok(await verifyChain(prisma));
});
