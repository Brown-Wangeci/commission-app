import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { recordAuditEvent } from "@/lib/activations/transition";
import { prisma } from "@/lib/db";

/**
 * A client may require a reviewer before any payment on its submissions. The
 * setting is read when a decision is made, not when work is submitted, so a
 * change applies to every submission not yet decided. Scoring is unaffected,
 * and so is every path that already ends with a person or in a refusal.
 */
export const reviewSettingSchema = z.object({ reviewAllSubmissions: z.boolean() });

export type ReviewSettingSource = {
  reviewAllSubmissions: boolean | null;
  client: { reviewAllSubmissions: boolean };
};

/** The job's own setting where it has one, otherwise the client's. */
export function reviewRequired(job: ReviewSettingSource): boolean {
  return job.reviewAllSubmissions ?? job.client.reviewAllSubmissions;
}

export async function activationNeedsReviewer(tx: Prisma.TransactionClient, activationId: string): Promise<boolean> {
  const { job } = await tx.activation.findUniqueOrThrow({
    where: { id: activationId },
    select: { job: { select: { reviewAllSubmissions: true, client: { select: { reviewAllSubmissions: true } } } } },
  });
  return reviewRequired(job);
}

export type ReviewSettingInput = { clientId: string; actorId: string; reviewAllSubmissions: boolean; at?: Date };

/** Changes the client's setting and records who changed it. Saving the same value records nothing. */
export async function setClientReviewSetting(input: ReviewSettingInput): Promise<{ changed: boolean }> {
  const { clientId, reviewAllSubmissions } = input;
  return prisma.$transaction(async (tx) => {
    const result = await tx.clientBusiness.updateMany({
      where: { id: clientId, reviewAllSubmissions: !reviewAllSubmissions },
      data: { reviewAllSubmissions },
    });
    if (result.count === 0) return { changed: false };
    const client = await tx.clientBusiness.findUniqueOrThrow({ where: { id: clientId } });
    await recordAuditEvent(tx, {
      kind: "review_setting_changed",
      actorId: input.actorId,
      detail: `${client.name}: reviewer required before any payment turned ${reviewAllSubmissions ? "on" : "off"}.`,
      at: input.at,
    });
    return { changed: true };
  });
}
