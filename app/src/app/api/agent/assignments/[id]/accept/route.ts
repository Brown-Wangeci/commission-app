import { agentFor } from "@/lib/auth/actors";
import { requireApiRole } from "@/lib/auth/session";
import { acceptAssignment } from "@/lib/escrow/holds";
import { ok, withErrors } from "@/lib/http/route";
import { idSchema } from "@/lib/validation";

/** The agent accepts a job assigned to them. */
export const POST = withErrors<{ id: string }>("POST /api/agent/assignments/[id]/accept", async (_request, { params }) => {
  const agent = await agentFor(await requireApiRole("agent"));
  const assignment = await acceptAssignment({ assignmentId: idSchema.parse((await params).id), agentId: agent.id });
  return ok({ assignmentId: assignment.id, acceptedAt: assignment.acceptedAt });
});
