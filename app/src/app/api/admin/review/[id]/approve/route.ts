import { z } from "zod";
import { requireApiRole } from "@/lib/auth/session";
import { ok, readJson, withErrors } from "@/lib/http/route";
import { approveActivation } from "@/lib/review/actions";
import { idSchema, reasonTextSchema } from "@/lib/validation";

const bodySchema = z.object({ reason: reasonTextSchema });

/** Approve and pay: the reviewer's reason is required and recorded. */
export const POST = withErrors<{ id: string }>("POST /api/admin/review/[id]/approve", async (request, { params }) => {
  const reviewer = await requireApiRole("admin");
  const activationId = idSchema.parse((await params).id);
  const { reason } = await readJson(request, bodySchema);
  await approveActivation({ activationId, reviewerId: reviewer.id, reason });
  return ok({ activationId, action: "approve" });
});
