import { z } from "zod";
import { requireApiRole } from "@/lib/auth/session";
import { ok, readJson, withErrors } from "@/lib/http/route";
import { refuseActivation } from "@/lib/review/actions";
import { idSchema, reasonTextSchema } from "@/lib/validation";

const bodySchema = z.object({ reason: reasonTextSchema });

/** Refuse: the reviewer's reason is required and recorded. */
export const POST = withErrors<{ id: string }>("POST /api/admin/review/[id]/refuse", async (request, { params }) => {
  const reviewer = await requireApiRole("admin");
  const activationId = idSchema.parse((await params).id);
  const { reason } = await readJson(request, bodySchema);
  await refuseActivation({ activationId, reviewerId: reviewer.id, reason });
  return ok({ activationId, action: "refuse" });
});
