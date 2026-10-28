import { z } from "zod";
import { requireApiRole } from "@/lib/auth/session";
import { ok, readJson, withErrors } from "@/lib/http/route";
import { requestEvidence } from "@/lib/review/actions";
import { idSchema, reasonTextSchema } from "@/lib/validation";

const bodySchema = z.object({ reason: reasonTextSchema });

/** Ask the agent for more evidence; the message says what is needed. */
export const POST = withErrors<{ id: string }>("POST /api/admin/review/[id]/request-evidence", async (request, { params }) => {
  const reviewer = await requireApiRole("admin");
  const activationId = idSchema.parse((await params).id);
  const { reason } = await readJson(request, bodySchema);
  await requestEvidence({ activationId, reviewerId: reviewer.id, reason });
  return ok({ activationId, action: "request-evidence" });
});
