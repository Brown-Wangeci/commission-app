import { agentFor, clientFor } from "@/lib/auth/actors";
import { requireApiRole } from "@/lib/auth/session";
import type { RoleName } from "@/lib/auth/policy";
import { prisma } from "@/lib/db";
import { notFound } from "@/lib/http/errors";

/**
 * Who may read a submission's audit record (FR-22): an administrator, the
 * agent who submitted it, and the client whose job it was for. Anyone else
 * gets the same 404 as for a submission that does not exist.
 */
export async function requireAuditAccess(role: RoleName, activationId: string): Promise<void> {
  const user = await requireApiRole(role);
  const activation = await prisma.activation.findUnique({ where: { id: activationId }, select: { agentId: true, job: { select: { clientId: true } } } });
  if (!activation) throw notFound("Submission");
  if (role === "agent" && activation.agentId !== (await agentFor(user)).id) throw notFound("Submission");
  if (role === "client" && activation.job.clientId !== (await clientFor(user)).id) throw notFound("Submission");
}
