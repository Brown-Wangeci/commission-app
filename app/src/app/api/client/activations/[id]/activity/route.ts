import { clientFor } from "@/lib/auth/actors";
import { requireApiRole } from "@/lib/auth/session";
import { activityReportSchema, reportActivity } from "@/lib/activity/report";
import { ok, readJson, withErrors } from "@/lib/http/route";
import { idSchema } from "@/lib/validation";

/** The client reports first-week customer activity for an activation on its job. */
export const POST = withErrors<{ id: string }>("POST /api/client/activations/[id]/activity", async (request, { params }) => {
  const user = await requireApiRole("client");
  const client = await clientFor(user);
  const activationId = idSchema.parse((await params).id);
  const report = await readJson(request, activityReportSchema);
  const days = await reportActivity({ clientId: client.id, activationId, report, actorId: user.id });
  return ok({ days });
});
