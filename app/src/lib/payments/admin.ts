import type { DisbursementStatus, FundingAttempt, PaymentCallback } from "@prisma/client";
import type { Tx } from "@/lib/db";

/** What an administrator reads for each disbursement state (D2). */
export const DISBURSEMENT_DISPLAY: Record<DisbursementStatus, { label: string; chip: string; detail: string }> = {
  queued: { label: "Queued", chip: "review", detail: "Waiting to be sent to M-Pesa." },
  sending: { label: "Sending", chip: "review", detail: "Being sent to M-Pesa now." },
  sent: { label: "Sent", chip: "held", detail: "M-Pesa accepted it. Waiting for the result." },
  unconfirmed: { label: "Unconfirmed", chip: "disputed", detail: "The outcome is not known yet. It will not be sent again." },
  paid: { label: "Paid", chip: "approved", detail: "M-Pesa confirmed the payment." },
  failed: { label: "Failed", chip: "failure", detail: "M-Pesa did not pay this." },
};

export type PaymentAttention = {
  funding: Array<FundingAttempt & { client: { name: string } }>;
  callbacks: PaymentCallback[];
};

/**
 * Funding that needs a person, and callbacks that could not be matched or
 * that contradicted a settled record. Disbursements are listed by the page
 * itself, with their failure reasons.
 */
export async function paymentAttention(db: Tx, take = 20): Promise<PaymentAttention> {
  const [funding, callbacks] = await Promise.all([
    db.fundingAttempt.findMany({ where: { escalatedAt: { not: null }, status: { not: "confirmed" } }, include: { client: { select: { name: true } } }, orderBy: { escalatedAt: "desc" }, take }),
    db.paymentCallback.findMany({ where: { outcome: { in: ["conflict", "unknown_reference"] } }, orderBy: { lastReceivedAt: "desc" }, take }),
  ]);
  return { funding, callbacks };
}
