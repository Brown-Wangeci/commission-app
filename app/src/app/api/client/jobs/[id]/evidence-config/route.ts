import { z } from "zod";
import { prisma } from "@/lib/db";
import { clientFor } from "@/lib/auth/actors";
import { requireApiRole } from "@/lib/auth/session";
import { configHistory, currentEvidenceConfig, updateEvidenceConfig } from "@/lib/evidence/config";
import { notFound } from "@/lib/http/errors";
import { ok, readJson, withErrors } from "@/lib/http/route";
import { idSchema } from "@/lib/validation";

async function ownJob(clientId: string, jobId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || job.clientId !== clientId) throw notFound("Job");
  return job;
}

/** The job's current evidence configuration and every earlier version (issue #46). */
export const GET = withErrors<{ id: string }>("GET /api/client/jobs/[id]/evidence-config", async (_request, { params }) => {
  const client = await clientFor(await requireApiRole("client"));
  const job = await ownJob(client.id, idSchema.parse((await params).id));
  const [current, history] = await Promise.all([currentEvidenceConfig(prisma, job.id), configHistory(prisma, job.id)]);
  return ok({ current, history });
});

const bodySchema = z.object({ fields: z.array(z.unknown()) });

/** Replaces the job's evidence fields with a new version; earlier submissions keep theirs. */
export const POST = withErrors<{ id: string }>("POST /api/client/jobs/[id]/evidence-config", async (request, { params }) => {
  const user = await requireApiRole("client");
  const client = await clientFor(user);
  const jobId = idSchema.parse((await params).id);
  const { fields } = await readJson(request, bodySchema);
  const created = await updateEvidenceConfig({ jobId, clientId: client.id, actorId: user.id, fields });
  return ok({ evidenceConfigId: created.id, version: created.version, fields: created.fields }, 201);
});
