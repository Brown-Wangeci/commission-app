import type { PayoutAuthorisation, Prisma } from "@prisma/client";
import { recordAuditEvent } from "@/lib/activations/transition";
import { formatKsh } from "@/lib/format";
import { payoutAuthoriser, usePayoutAuthoriser, type PayoutAuthoriser } from "./boundary";
import { NoopPayoutAuthoriser } from "./noop";

/**
 * The single entry point upstream code uses. It reads the amount from the
 * escrow hold and the number from the agent's profile, then hands both to
 * whichever `PayoutAuthoriser` is registered.
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
  const authorisation = await payoutAuthoriser().authorise(tx, {
    activationId: activation.id,
    amountKsh: hold.amountKsh,
    payoutMsisdn: activation.agent.payoutMsisdn,
    authorisedById: input.authorisedById,
    at: input.at,
  });
  await recordAuditEvent(tx, {
    kind: "payout_authorised",
    activationId: activation.id,
    actorId: input.authorisedById,
    detail: `${formatKsh(hold.amountKsh)} to ${activation.agent.payoutMsisdn} authorised via ${authorisation.provider}.`,
    at: input.at,
  });
  return authorisation;
}
