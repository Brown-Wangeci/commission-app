import type { PayoutAuthorisation, Prisma } from "@prisma/client";
import { recordAuthorisation, type PayoutAuthoriser, type PayoutRequest } from "./boundary";

/**
 * Records the authorisation and does nothing else. No money moves, no
 * external service is called. Stands in until settlement is designed
 * (issue #14).
 */
export class NoopPayoutAuthoriser implements PayoutAuthoriser {
  readonly provider = "noop";

  authorise(tx: Prisma.TransactionClient, request: PayoutRequest): Promise<PayoutAuthorisation> {
    return recordAuthorisation(tx, request, this.provider, null);
  }
}
