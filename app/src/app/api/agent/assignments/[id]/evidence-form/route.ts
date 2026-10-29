import { prisma } from "@/lib/db";
import { agentFor } from "@/lib/auth/actors";
import { requireApiRole } from "@/lib/auth/session";
import { assignmentForSubmission } from "@/lib/agents/views";
import { currentEvidenceConfig } from "@/lib/evidence/config";
import { PLATFORM_FIELDS } from "@/lib/evidence/platform";
import { ok, withErrors } from "@/lib/http/route";
import { idSchema } from "@/lib/validation";

/**
 * The capture form's definition for one assignment (FR-09, issue #47): the
 * platform's fields, then the job's fields from its current configuration
 * version, whose id the submission must send back as evidenceConfigId.
 */
export const GET = withErrors<{ id: string }>("GET /api/agent/assignments/[id]/evidence-form", async (_request, { params }) => {
  const agent = await agentFor(await requireApiRole("agent"));
  const assignment = await assignmentForSubmission(agent.id, idSchema.parse((await params).id));
  const config = await currentEvidenceConfig(prisma, assignment.jobId);
  return ok({
    assignmentId: assignment.id,
    evidenceConfigId: config.id,
    version: config.version,
    deadlineAt: assignment.job.deadlineAt,
    platformFields: PLATFORM_FIELDS,
    jobFields: config.fields,
  });
});
