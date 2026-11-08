import type { Disbursement } from "@prisma/client";
import { recordAuditEvent } from "@/lib/activations/transition";
import { prisma } from "@/lib/db";
import { conflict, notFound } from "@/lib/http/errors";
import { formatCents } from "@/lib/money/cents";
import { b2cAmountProblem } from "./amount";
import { newReference } from "./callback-url";

/**
 * An administrator retries a failed payout (Build 4, F). Only a definite
 * failure can be retried: Daraja refused it, reported a failed result, or was
 * never reached. An unconfirmed payout may already have been paid, so it can
 * never be retried from here.
 *
 * The retry is a new generation with a new reference, because Daraja refuses
 * a repeated OriginatorConversationID. The old reference is kept, so a late
 * callback for it is recognised and, if it claims success, raised rather
 * than paid. The database allows this one move from failed to queued and
 * nothing else; the escrow stays held throughout.
 */
const NOT_RETRYABLE: Record<string, string> = {
  queued: "This payout is already waiting to be sent.",
  sending: "This payout is being sent now.",
  sent: "M-Pesa has accepted this payout; its result is awaited.",
  unconfirmed: "M-Pesa may already have paid this. Check the M-Pesa portal; it cannot be retried from here.",
  paid: "This payout has been paid.",
};

export async function retryDisbursement(input: { disbursementId: string; actorId: string; at?: Date }): Promise<Disbursement> {
  const at = input.at ?? new Date();
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Disbursement" WHERE "id" = ${input.disbursementId} FOR UPDATE`;
    const row = await tx.disbursement.findUnique({ where: { id: input.disbursementId } });
    if (!row) throw notFound("Payout");
    if (row.status !== "failed") throw conflict(NOT_RETRYABLE[row.status] ?? "This payout cannot be retried.");
    const problem = b2cAmountProblem(row.amountCents);
    if (problem) throw conflict(`This payout would fail again: ${problem}`);
    const reference = newReference();
    const retried = await tx.disbursement.update({
      where: { id: row.id },
      data: {
        status: "queued",
        reference,
        generation: row.generation + 1,
        previousReferences: [...row.previousReferences, row.reference],
        sendCount: 0,
        queryCount: 0,
        nextAttemptAt: at,
        lockedUntil: null,
        conversationId: null,
        resultCode: null,
        failureReason: null,
        lastError: null,
        escalatedAt: null,
        acceptedAt: null,
        resolvedAt: null,
      },
    });
    await recordAuditEvent(tx, {
      kind: "payout_retried",
      activationId: row.activationId,
      actorId: input.actorId,
      detail: `${formatCents(row.amountCents)} payout retried as generation ${retried.generation}, after: ${row.failureReason ?? "a failure"}.`,
      at,
    });
    return retried;
  });
}
