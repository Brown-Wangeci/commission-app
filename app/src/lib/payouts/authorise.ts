import type { PayoutAuthorisation, Prisma } from "@prisma/client";
import { recordAuditEvent } from "@/lib/activations/transition";
import { formatCents } from "@/lib/money/cents";
import { payoutAuthoriser, usePayoutAuthoriser, type PayoutAuthoriser } from "./boundary";
import { recordCommission, storedCommissionView } from "./commissions";
import { NoopPayoutAuthoriser } from "./noop";

/**
 * The single entry point upstream code uses, called on every path to
 * approval. It records the activation's commission (issue #41), checks the
 * escrow hold covers exactly that amount, and hands the commission's amount
 * and the agent's number to whichever `PayoutAuthoriser` is registered.
 */
const IMPLEMENTATIONS: Record<string, () => PayoutAuthoriser> = { noop: () => new NoopPayoutAuthoriser() };

function ensureRegistered(): void {
  try {
    payoutAuthoriser();
  } catch {
    const name = process.env.PAYOUT_AUTHORISER ?? "noop";
    const make = IMPLEMENTATIONS[name];
    if (!make) throw new Error(`Unknown PAYOUT_AUTHORISER "${name}".`);
    usePayoutAuthoriser(make());
  }
}

export async function authorisePayout(
  tx: Prisma.TransactionClient,
  input: { activationId: string; authorisedById: string | null; at: Date },
): Promise<PayoutAuthorisation> {
  ensureRegistered();
  const activation = await tx.activation.findUniqueOrThrow({
    where: { id: input.activationId },
    include: { assignment: { include: { hold: true } }, agent: true },
  });
  const hold = activation.assignment.hold;
  if (!hold) throw new Error(`Activation ${activation.reference} has no escrow hold to pay from.`);
  const commission = await recordCommission(tx, { activationId: activation.id, approvedById: input.authorisedById, at: input.at });
  if (commission.amountCents !== hold.amountCents) {
    throw new Error(
      `Activation ${activation.reference}: commission ${formatCents(commission.amountCents)} differs from its escrow hold ${formatCents(hold.amountCents)}.`,
    );
  }
  const authorisation = await payoutAuthoriser().authorise(tx, {
    activationId: activation.id,
    commissionId: commission.id,
    amountCents: commission.amountCents,
    payoutMsisdn: activation.agent.payoutMsisdn,
    authorisedById: input.authorisedById,
    at: input.at,
  });
  await recordAuditEvent(tx, {
    kind: "payout_authorised",
    activationId: activation.id,
    actorId: input.authorisedById,
    detail:
      `${formatCents(commission.amountCents)} to ${activation.agent.payoutMsisdn} authorised via ${authorisation.provider}: ` +
      `${storedCommissionView(commission).derivation}.`,
    at: input.at,
  });
  return authorisation;
}
