import { prisma } from "@/lib/db";
import { handleCallback } from "@/lib/payments/callbacks";
import { authorisePayout } from "@/lib/payouts/authorise";
import { b2cResultBody, simulatedReceipt } from "../../prisma/seed-support/simulated-payments";

/**
 * For an activation already approved by walking its states directly: records
 * its commission and payout, as approval does, and optionally delivers a
 * simulated successful B2C result through the real callback handler. Escrow
 * is released only by that payment.
 */
export async function authorise(activationId: string, at: Date = new Date()) {
  await prisma.$transaction((tx) => authorisePayout(tx, { activationId, authorisedById: null, at }));
  return prisma.disbursement.findUniqueOrThrow({ where: { activationId } });
}

export async function deliverPayment(activationId: string, at: Date = new Date()): Promise<void> {
  const row = await prisma.disbursement.findUniqueOrThrow({ where: { activationId } });
  const payload = b2cResultBody({ reference: row.reference, amountCents: row.amountCents, receipt: simulatedReceipt() });
  await handleCallback({ kind: "b2c-result", reference: row.reference, payload, at });
}

export async function authoriseAndPay(activationId: string, at: Date = new Date()): Promise<void> {
  await authorise(activationId, at);
  await deliverPayment(activationId, at);
}
