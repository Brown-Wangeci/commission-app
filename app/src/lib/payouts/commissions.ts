import type { Commission, Prisma } from "@prisma/client";
import { commissionView, computeCommission, type CommissionBreakdown, type CommissionView } from "@/lib/money/commission";

/**
 * The commission record (FR-18, issue #41). Written once, at approval, in
 * the approving transaction, and never changed: it copies the job's
 * commission structure so the amount can be recomputed from the record
 * alone. The database allows one per activation, only for an approved
 * activation, only with its job's structure, and rejects any later UPDATE
 * or DELETE.
 *
 * The amount stored is what is paid: the commission rounded down to whole
 * shillings, with the odd cents recorded beside it (Build 4). The payout,
 * the authorisation and the B2C instruction all carry this amount.
 */
export async function recordCommission(
  tx: Prisma.TransactionClient,
  input: { activationId: string; approvedById: string | null; at: Date },
): Promise<Commission> {
  const activation = await tx.activation.findUniqueOrThrow({ where: { id: input.activationId }, include: { job: true } });
  if (activation.state !== "approved") {
    throw new Error(`Activation ${activation.reference} is ${activation.state}; a commission is recorded only on approval.`);
  }
  const breakdown = computeCommission(activation.job);
  return tx.commission.create({
    data: {
      activationId: activation.id,
      jobId: activation.jobId,
      submissionValueCents: breakdown.submissionValueCents,
      commissionRateBps: breakdown.commissionRateBps,
      rateComponentCents: breakdown.rateComponentCents,
      flatCommissionCents: breakdown.flatCommissionCents,
      amountCents: breakdown.payableCents,
      roundedOffCents: breakdown.roundedOffCents,
      computedAt: input.at,
      approvedById: input.approvedById,
    },
  });
}

/**
 * A stored commission with its derivation. The breakdown is recomputed from
 * the copied structure, and the amount paid plus what was rounded off must
 * equal it; a mismatch means the record was not produced by this calculation
 * and is reported, not hidden. Records from before Build 4 were not rounded:
 * they show what they paid, with no rounding step.
 */
export function storedCommissionView(record: Commission): CommissionView {
  const recomputed: CommissionBreakdown = computeCommission(record);
  if (recomputed.rateComponentCents !== record.rateComponentCents || record.amountCents + record.roundedOffCents !== recomputed.amountCents) {
    throw new Error(`Commission ${record.id} does not match its own structure.`);
  }
  return commissionView({ ...recomputed, payableCents: record.amountCents, roundedOffCents: record.roundedOffCents });
}
