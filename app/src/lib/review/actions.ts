import type { ActivationState, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { conflict, notFound } from "@/lib/http/errors";
import { notify } from "@/lib/notifications";
import { recordAuditEvent, transitionActivation } from "@/lib/activations/transition";
import { openDispute, resolveDispute } from "@/lib/disputes/disputes";
import { authorisePayout } from "@/lib/payouts/authorise";
import { closeReviewItem } from "./items";

/**
 * Reviewer actions. Each one records who decided, when and why: the
 * transition (with actor and note) goes to the audit log through the
 * database trigger, and the review item is closed with the reviewer, the
 * reason and the scoring decision that was in force.
 */
export type ReviewerInput = { activationId: string; reviewerId: string; reason: string; at?: Date };

type Loaded = { state: ActivationState; agentUserId: string; reference: string; latestDecisionId: string | null };

async function load(tx: Prisma.TransactionClient, activationId: string): Promise<Loaded> {
  const activation = await tx.activation.findUnique({
    where: { id: activationId },
    include: { agent: true, decisions: { orderBy: { recordedAt: "desc" }, take: 1 } },
  });
  if (!activation) throw notFound("Activation");
  return {
    state: activation.state,
    agentUserId: activation.agent.userId,
    reference: activation.reference,
    latestDecisionId: activation.decisions[0]?.id ?? null,
  };
}

function requireState(current: ActivationState, allowed: ActivationState[], action: string): void {
  if (!allowed.includes(current)) throw conflict(`Cannot ${action} an activation that is ${current.replace("_", " ")}.`);
}

type DisputeEffectInput = ReviewerInput & {
  at: Date;
  from: ActivationState;
  to: "approved" | "refused";
  reviewItemId: string | null;
  decisionId: string | null;
};

/**
 * A first refusal opens a dispute record; a decision on a contested refusal
 * resolves it (refuse = upheld, approve = overturned). Approving an item
 * that was never refused creates nothing.
 */
async function recordDisputeEffect(tx: Prisma.TransactionClient, input: DisputeEffectInput): Promise<void> {
  if (input.from === "disputed") {
    const outcome = input.to === "refused" ? "upheld" : "overturned";
    await resolveDispute(tx, { activationId: input.activationId, outcome, reviewerId: input.reviewerId, note: input.reason, at: input.at });
    return;
  }
  if (input.to === "refused") {
    await openDispute(tx, {
      activationId: input.activationId,
      decisionId: input.decisionId,
      reviewItemId: input.reviewItemId,
      refusedById: input.reviewerId,
      reason: input.reason,
      at: input.at,
    });
  }
}

async function decide(input: ReviewerInput, to: "approved" | "refused"): Promise<void> {
  const at = input.at ?? new Date();
  await prisma.$transaction(async (tx) => {
    const current = await load(tx, input.activationId);
    requireState(current.state, ["in_review", "disputed"], to === "approved" ? "approve" : "refuse");
    await transitionActivation(tx, {
      activationId: input.activationId, from: current.state, to, actorId: input.reviewerId, note: input.reason, at,
    });
    const reviewItemId = await closeReviewItem(tx, {
      activationId: input.activationId, action: to, reviewerId: input.reviewerId, reason: input.reason, decisionId: current.latestDecisionId, at,
    });
    await recordDisputeEffect(tx, { ...input, at, from: current.state, to, reviewItemId, decisionId: current.latestDecisionId });
    if (to === "approved") await authorisePayout(tx, { activationId: input.activationId, authorisedById: input.reviewerId, at });
    await notify(tx, {
      userId: current.agentUserId,
      kind: to,
      activationId: input.activationId,
      message: `${current.reference} was ${to} by a reviewer: ${input.reason}`,
    });
  });
}

export function approveActivation(input: ReviewerInput): Promise<void> {
  return decide(input, "approved");
}

export function refuseActivation(input: ReviewerInput): Promise<void> {
  return decide(input, "refused");
}

/**
 * "Ask for evidence": parks the item in awaiting_evidence, records what was
 * asked and by whom, and notifies the agent. The agent's response returns
 * it to the queue (respondToEvidenceRequest).
 */
export async function requestEvidence(input: ReviewerInput): Promise<string> {
  const at = input.at ?? new Date();
  return prisma.$transaction(async (tx) => {
    const current = await load(tx, input.activationId);
    requireState(current.state, ["in_review"], "ask for evidence on");
    await transitionActivation(tx, {
      activationId: input.activationId, from: "in_review", to: "awaiting_evidence", actorId: input.reviewerId, note: input.reason, at,
    });
    await closeReviewItem(tx, {
      activationId: input.activationId, action: "evidence_requested", reviewerId: input.reviewerId, reason: input.reason, decisionId: current.latestDecisionId, at,
    });
    const request = await tx.evidenceRequest.create({
      data: { activationId: input.activationId, requestedById: input.reviewerId, requestedAt: at, message: input.reason },
    });
    await notify(tx, {
      userId: current.agentUserId,
      kind: "evidence_requested",
      activationId: input.activationId,
      message: `A reviewer needs more evidence for ${current.reference}: ${input.reason}`,
    });
    await recordAuditEvent(tx, {
      kind: "evidence_requested", activationId: input.activationId, actorId: input.reviewerId, detail: input.reason, at,
    });
    return request.id;
  });
}
