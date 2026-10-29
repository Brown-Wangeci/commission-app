import { assertCents, formatBps, formatCents, MoneyError, multiplyCents } from "./cents";

/**
 * A job's commission structure (FR-18, issue #41), and the one calculation
 * that turns it into an amount:
 *
 *   commission = floor(submission value x rate in basis points / 10000)
 *                + flat amount per approved submission
 *
 * in integer cents. The product and the division are BigInt operations, so
 * the result is exact for any amount a record can hold, and integer division
 * of non-negative numbers is the floor. No floating point value appears
 * anywhere in the calculation.
 */

export const BPS_PER_WHOLE = 10_000;

export type CommissionStructure = {
  /** What one approved submission is worth to the client: the base the rate applies to. */
  submissionValueCents: number;
  /** 1 to 10000; 10000 is 100%. */
  commissionRateBps: number;
  /** Paid on top of the rate component for each approved submission. */
  flatCommissionCents: number;
};

export type CommissionBreakdown = CommissionStructure & {
  /** floor(submissionValueCents x commissionRateBps / 10000) */
  rateComponentCents: number;
  /** True when the floor dropped a fraction of a cent. */
  roundedDown: boolean;
  /** rateComponentCents + flatCommissionCents */
  amountCents: number;
};

export function assertRateBps(bps: number): number {
  if (!Number.isSafeInteger(bps) || bps < 1 || bps > BPS_PER_WHOLE) {
    throw new MoneyError(`The commission rate must be a whole number of basis points from 1 to ${BPS_PER_WHOLE} (got ${String(bps)}).`);
  }
  return bps;
}

export function computeCommission(structure: CommissionStructure): CommissionBreakdown {
  const value = BigInt(assertCents(structure.submissionValueCents, "The submission value"));
  const bps = BigInt(assertRateBps(structure.commissionRateBps));
  const flat = BigInt(assertCents(structure.flatCommissionCents, "The flat commission"));
  const product = value * bps;
  const rateComponent = product / BigInt(BPS_PER_WHOLE);
  const amount = assertCents(Number(rateComponent + flat), "The commission");
  return {
    submissionValueCents: structure.submissionValueCents,
    commissionRateBps: structure.commissionRateBps,
    flatCommissionCents: structure.flatCommissionCents,
    rateComponentCents: Number(rateComponent),
    roundedDown: product % BigInt(BPS_PER_WHOLE) !== 0n,
    amountCents: amount,
  };
}

/**
 * The derivation line the design system requires under every computed
 * amount, e.g. "KSh 3,000.00 x 10.00% = KSh 300.00 + KSh 20.00 flat".
 */
export function commissionDerivation(breakdown: CommissionBreakdown): string {
  const rounding = breakdown.roundedDown ? " (rounded down to the cent)" : "";
  const rate = `${formatCents(breakdown.submissionValueCents)} × ${formatBps(breakdown.commissionRateBps)} = ${formatCents(breakdown.rateComponentCents)}${rounding}`;
  return breakdown.flatCommissionCents > 0 ? `${rate} + ${formatCents(breakdown.flatCommissionCents)} flat` : rate;
}

export type Liability = { slots: number; perSubmissionCents: number; amountCents: number };

/** A job's maximum liability: every slot paid in full. Locked at publication (FR-07). */
export function maxLiability(structure: CommissionStructure, slots: number): Liability {
  const perSubmissionCents = computeCommission(structure).amountCents;
  return { slots, perSubmissionCents, amountCents: multiplyCents(perSubmissionCents, slots, "The job's maximum liability") };
}

export function liabilityDerivation(liability: Liability): string {
  return `${liability.slots} × ${formatCents(liability.perSubmissionCents)} per approved submission`;
}

/** The commission with its derivation, as the API returns it (B5). */
export type CommissionView = CommissionBreakdown & { derivation: string };

export function commissionView(breakdown: CommissionBreakdown): CommissionView {
  return { ...breakdown, derivation: commissionDerivation(breakdown) };
}
