import { z } from "zod";
import { requireApiRole } from "@/lib/auth/session";
import { assignJob } from "@/lib/escrow/holds";
import { ok, readJson, withErrors } from "@/lib/http/route";
import { idSchema } from "@/lib/validation";

const bodySchema = z.object({ agentId: idSchema });

/** An administrator assigns one slot of a job to an agent; one commission is reserved from the job's locked escrow. */
export const POST = withErrors<{ id: string }>("POST /api/admin/jobs/[id]/assign", async (request, { params }) => {
  const admin = await requireApiRole("admin");
  const jobId = idSchema.parse((await params).id);
  const { agentId } = await readJson(request, bodySchema);
  const assignment = await assignJob({ jobId, agentId, assignedById: admin.id });
  return ok({ assignmentId: assignment.id, holdCents: assignment.hold?.amountCents ?? null }, 201);
});
