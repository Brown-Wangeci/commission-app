import type { Commission } from "@prisma/client";
import { commissionView, computeCommission, type CommissionStructure, type CommissionView } from "@/lib/money/commission";
import { storedCommissionView } from "./commissions";

/**
 * What an activation pays, and why, for every screen and API that shows it.
 * Once approved, the amount and its derivation come from the stored
 * commission record. Before that, they are what approval would pay under the
 * job's commission structure, which is also what the escrow hold reserved.
 */
export type PayoutAmountView = {
  amountCents: number;
  commission: CommissionView;
  basis: "recorded" | "job_terms";
};

export function payoutAmountView(input: {
  job: CommissionStructure;
  hold: { amountCents: number } | null;
  commission: Commission | null;
}): PayoutAmountView | null {
  if (input.commission) {
    const recorded = storedCommissionView(input.commission);
    return { amountCents: recorded.amountCents, commission: recorded, basis: "recorded" };
  }
  if (!input.hold) return null;
  const terms = commissionView(computeCommission(input.job));
  return { amountCents: terms.amountCents, commission: terms, basis: "job_terms" };
}
