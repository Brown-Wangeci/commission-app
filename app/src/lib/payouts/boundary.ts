import type { PayoutAuthorisation, Prisma } from "@prisma/client";

/**
 * The payout authorisation boundary (issue #15).
 *
 * Everything upstream (reviewer approval, automatic release at hold-close)
 * calls `authorisePayout` and nothing else. How an authorised payout is
 * settled is deliberately unknown here: settlement is being redesigned
 * (issue #14). A real implementation replaces the no-op by implementing
 * `PayoutAuthoriser` and registering it; no upstream code changes.
 *
 * The call happens inside the database transaction that approves the
 * activation, so an authoriser that throws rolls the approval back.
 */
export type PayoutRequest = {
  activationId: string;
  amountKsh: number;
  payoutMsisdn: string;
  /** The reviewer who approved, or null for an automatic release. */
  authorisedById: string | null;
  at: Date;
};

export interface PayoutAuthoriser {
  /** Short provider name stored with each authorisation, e.g. "noop". */
  readonly provider: string;
  authorise(tx: Prisma.TransactionClient, request: PayoutRequest): Promise<PayoutAuthorisation>;
}

/** Shared by implementations: the platform's own record of an authorisation. */
export function recordAuthorisation(
  tx: Prisma.TransactionClient,
  request: PayoutRequest,
  provider: string,
  providerRef: string | null,
): Promise<PayoutAuthorisation> {
  return tx.payoutAuthorisation.create({
    data: {
      activationId: request.activationId,
      amountKsh: request.amountKsh,
      payoutMsisdn: request.payoutMsisdn,
      authorisedAt: request.at,
      authorisedById: request.authorisedById,
      provider,
      providerRef,
    },
  });
}

let current: PayoutAuthoriser | null = null;

/** Registers the implementation in use. Called once at start-up, or by tests. */
export function usePayoutAuthoriser(authoriser: PayoutAuthoriser): void {
  current = authoriser;
}

export function payoutAuthoriser(): PayoutAuthoriser {
  if (!current) throw new Error("No payout authoriser registered.");
  return current;
}
