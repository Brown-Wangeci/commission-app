import { simulateConfirmedFunding } from "../../prisma/seed-support/simulated-payments";

/**
 * Puts money in a client's escrow for a test, through the same callback path
 * production uses. There is no shortcut: a deposit without a confirmed funding
 * attempt is refused by the database.
 */
export async function fundEscrow(input: { clientId: string; amountCents: number; actorId: string; at?: Date }): Promise<void> {
  await simulateConfirmedFunding(input);
}
