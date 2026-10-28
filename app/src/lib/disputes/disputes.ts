import type { Dispute, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { conflict, notFound } from "@/lib/http/errors";
import { notify } from "@/lib/notifications";
import { openReviewItem } from "@/lib/review/items";
import { recordAuditEvent, transitionActivation } from "@/lib/activations/transition";

/**
 * A refused payout always leaves a dispute record (issue #10), so the
 * refusal can be audited and, once, contested. The record carries the
 * scoring decision in force and, for a human refusal, the review item and
 * reviewer that made it. Approving never creates one.
 */
export type RefusalRecord = {
  activationId: string;
  decisionId: string | null;
  reviewItemId: string | null;
  refusedById: string | null;
  reason: string;
  at: Date;
};

export async function openDispute(tx: Prisma.TransactionClient, record: RefusalRecord): Promise<Dispute> {
  const dispute = await tx.dispute.create({
    data: {
      activationId: record.activationId,
      decisionId: record.decisionId,
      reviewItemId: record.reviewItemId,
      refusedById: record.refusedById,
      refusalReason: record.reason,
      openedAt: record.at,
    },
  });
  await recordAuditEvent(tx, {
    kind: "dispute_opened",
    activationId: record.activationId,
    actorId: record.refusedById,
    detail: `Refusal recorded for audit and contest: ${record.reason}`,
    at: record.at,
  });
  return dispute;
}

/** The reviewer's decision on a contested refusal. */
export async function resolveDispute(
  tx: Prisma.TransactionClient,
  input: { activationId: string; outcome: "upheld" | "overturned"; reviewerId: string; note: string; at: Date },
): Promise<void> {
  const updated = await tx.dispute.updateMany({
    where: { activationId: input.activationId, status: "contested" },
    data: { status: input.outcome, resolvedAt: input.at, resolvedById: input.reviewerId, resolutionNote: input.note },
  });
  if (updated.count === 0) throw conflict("There is no contested refusal to resolve on this activation.");
}

/**
 * The agent contests a refusal: refused -> disputed, back to a reviewer.
 * Allowed once; a refusal that was upheld after a contest is final.
 */
export async function contestRefusal(input: { agentId: string; activationId: string; note: string; at?: Date }): Promise<void> {
  const at = input.at ?? new Date();
  await prisma.$transaction(async (tx) => {
    const activation = await tx.activation.findUnique({ where: { id: input.activationId }, include: { dispute: true } });
    if (!activation || activation.agentId !== input.agentId) throw notFound("Activation");
    if (activation.state !== "refused" || !activation.dispute) throw conflict("Only a refused activation can be contested.");
    if (activation.dispute.status !== "open") throw conflict("This refusal has already been contested and decided.");
    await tx.dispute.update({ where: { id: activation.dispute.id }, data: { status: "contested", contestedAt: at, contestNote: input.note } });
    await transitionActivation(tx, { activationId: activation.id, from: "refused", to: "disputed", note: `Contested by the agent: ${input.note}`, at });
    await openReviewItem(tx, activation.id, "dispute", at);
    const reviewer = activation.dispute.refusedById;
    if (reviewer) {
      await notify(tx, { userId: reviewer, kind: "dispute", activationId: activation.id, message: `${activation.reference}: the agent contested your refusal.` });
    }
  });
}
