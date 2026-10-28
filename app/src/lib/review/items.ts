import type { Prisma, ReviewAction, ReviewOpenReason } from "@prisma/client";

/**
 * A ReviewItem records one stay in the review queue: why the activation
 * arrived, and who closed it, when, how and why.
 */
export async function openReviewItem(
  tx: Prisma.TransactionClient,
  activationId: string,
  reason: ReviewOpenReason,
  at: Date = new Date(),
): Promise<void> {
  await tx.reviewItem.create({ data: { activationId, openReason: reason, openedAt: at } });
}

export type CloseInput = {
  activationId: string;
  action: ReviewAction;
  reviewerId: string | null;
  reason: string;
  decisionId: string | null;
  at?: Date;
};

/** Closes the open review item, if any. Returns its id. */
export async function closeReviewItem(tx: Prisma.TransactionClient, input: CloseInput): Promise<string | null> {
  const open = await tx.reviewItem.findFirst({
    where: { activationId: input.activationId, closedAt: null },
    orderBy: { openedAt: "desc" },
  });
  if (!open) return null;
  await tx.reviewItem.update({
    where: { id: open.id },
    data: {
      closedAt: input.at ?? new Date(),
      action: input.action,
      reviewerId: input.reviewerId,
      reason: input.reason,
      decisionId: input.decisionId,
    },
  });
  return open.id;
}
