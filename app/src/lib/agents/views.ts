import { prisma } from "@/lib/db";
import { notFound } from "@/lib/http/errors";
import { WITHDRAWABLE_STATES } from "@/lib/activations/states";
import { configVersion } from "@/lib/evidence/config";
import { submittedFields } from "@/lib/evidence/view";
import { explainStatus, type StatusExplanation } from "./explain";

/** Data for the agent's own screens. Every query is scoped to the agent. */

const statusInclude = {
  job: { include: { client: true } },
  assignment: { include: { hold: true } },
  commission: true,
  decisions: { orderBy: { recordedAt: "asc" as const }, include: { reasons: { orderBy: { rank: "asc" as const } } } },
  reviewItems: { orderBy: { openedAt: "asc" as const } },
  evidenceRequests: { orderBy: { requestedAt: "asc" as const } },
  dispute: true,
};

type Loaded = Awaited<ReturnType<typeof loadOwn>>;

async function loadOwn(agentId: string, activationId: string) {
  const activation = await prisma.activation.findUnique({
    where: { id: activationId },
    include: { ...statusInclude, evidence: { orderBy: { sequence: "asc" } }, payout: true, evidenceConfig: true },
  });
  if (!activation || activation.agentId !== agentId) throw notFound("Activation");
  return activation;
}

function explanationOf(activation: Omit<Loaded, "evidence" | "payout" | "evidenceConfig">): StatusExplanation {
  const openRequest = activation.evidenceRequests.findLast((request) => request.status === "open");
  const withdrawn = activation.reviewItems.findLast((item) => item.action === "withdrawn_by_agent");
  return explainStatus({
    state: activation.state,
    unscoredStage: activation.unscoredStage,
    holdClosesAt: activation.holdClosesAt,
    decisions: activation.decisions,
    closedReviews: activation.reviewItems.filter((item) => item.closedAt !== null),
    openRequestMessage: openRequest?.message ?? null,
    dispute: activation.dispute,
    withdrawReason: withdrawn?.reason ?? null,
  });
}

export async function agentHome(agentId: string) {
  const assignments = await prisma.assignment.findMany({
    where: { agentId, activation: null },
    include: { job: { include: { client: true } }, hold: true },
    orderBy: { assignedAt: "desc" },
  });
  return {
    toAccept: assignments.filter((a) => a.acceptedAt === null),
    toSubmit: assignments.filter((a) => a.acceptedAt !== null),
  };
}

export async function agentActivations(agentId: string) {
  const activations = await prisma.activation.findMany({
    where: { agentId },
    include: statusInclude,
    orderBy: { submittedAt: "desc" },
  });
  return activations.map((activation) => ({ activation, explanation: explanationOf(activation) }));
}

export async function agentActivation(agentId: string, activationId: string) {
  const activation = await loadOwn(agentId, activationId);
  return {
    activation,
    /** What the agent submitted, labelled by the configuration version it was validated against. */
    fields: submittedFields(configVersion(activation.evidenceConfig), activation.evidencePayload),
    explanation: explanationOf(activation),
    openRequest: activation.evidenceRequests.findLast((request) => request.status === "open") ?? null,
    canWithdraw: WITHDRAWABLE_STATES.includes(activation.state),
    canContest: activation.state === "refused" && activation.dispute?.status === "open",
  };
}

export async function assignmentForSubmission(agentId: string, assignmentId: string) {
  const assignment = await prisma.assignment.findUnique({
    where: { id: assignmentId },
    include: { job: { include: { client: true } }, hold: true, activation: true },
  });
  if (!assignment || assignment.agentId !== agentId) throw notFound("Assignment");
  return assignment;
}
