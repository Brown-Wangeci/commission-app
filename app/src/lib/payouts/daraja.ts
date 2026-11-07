import type { PayoutAuthorisation, Prisma } from "@prisma/client";
import { newReference } from "@/lib/payments/callback-url";
import { queueDisbursement } from "@/lib/payments/disbursement";
import { recordAuthorisation, type PayoutAuthoriser, type PayoutRequest } from "./boundary";

/**
 * Settles an approved payout by M-Pesa B2C (issue #56, answering #14).
 *
 * `authorise` runs inside the approving transaction, so it must not call
 * Daraja: an HTTP call there could send money for an approval that then rolls
 * back, and an outage would block approvals. It records the authorisation and
 * queues one instruction in that same transaction, and the worker sends it
 * after the approval commits. The approval and its instruction therefore
 * commit together or not at all.
 */
export class DarajaPayoutAuthoriser implements PayoutAuthoriser {
  readonly provider = "daraja";

  async authorise(tx: Prisma.TransactionClient, request: PayoutRequest): Promise<PayoutAuthorisation> {
    const reference = newReference();
    const authorisation = await recordAuthorisation(tx, request, this.provider, reference);
    await queueDisbursement(tx, authorisation, reference);
    return authorisation;
  }
}
