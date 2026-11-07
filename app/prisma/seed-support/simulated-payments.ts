import { prisma } from "@/lib/db";
import { centsToDarajaAmount } from "@/lib/payments/amount";
import { newReference } from "@/lib/payments/callback-url";
import { handleCallback } from "@/lib/payments/callbacks";

/**
 * SIMULATED M-Pesa results, for seed data and tests only. Nothing here touched
 * Daraja, so nothing here is evidence of anything: the real sandbox run is in
 * docs/chapter5/evidence/mpesa/. Receipts start with SIM so a simulated
 * payment can never be mistaken for a real one.
 *
 * Money still moves only by the one real path: each result is delivered to
 * `handleCallback`, exactly as the callback route does after verifying origin.
 */
let receipts = 0;

export function simulatedReceipt(): string {
  receipts += 1;
  return `SIM${String(receipts).padStart(7, "0")}`;
}

export function stkSuccessBody(checkoutRequestId: string, amountCents: number, receipt: string): unknown {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: "simulated",
        CheckoutRequestID: checkoutRequestId,
        ResultCode: 0,
        ResultDesc: "The service request is processed successfully.",
        CallbackMetadata: {
          Item: [
            { Name: "Amount", Value: centsToDarajaAmount(amountCents) },
            { Name: "MpesaReceiptNumber", Value: receipt },
            { Name: "TransactionDate", Value: 20261107120000 },
            { Name: "PhoneNumber", Value: 254700000000 },
          ],
        },
      },
    },
  };
}

export function stkFailureBody(checkoutRequestId: string, resultCode: number, resultDesc: string): unknown {
  return { Body: { stkCallback: { MerchantRequestID: "simulated", CheckoutRequestID: checkoutRequestId, ResultCode: resultCode, ResultDesc: resultDesc } } };
}

export function b2cResultBody(input: { reference: string; amountCents: number; resultCode?: number; resultDesc?: string; receipt?: string; conversationId?: string }): unknown {
  const resultCode = input.resultCode ?? 0;
  const success = resultCode === 0;
  return {
    Result: {
      ResultType: 0,
      ResultCode: resultCode,
      ResultDesc: input.resultDesc ?? "The service request is processed successfully.",
      OriginatorConversationID: input.reference,
      ConversationID: input.conversationId ?? `AG_SIM_${input.reference}`,
      TransactionID: input.receipt ?? "SIM0000000",
      ...(success
        ? {
            ResultParameters: {
              ResultParameter: [
                { Key: "TransactionAmount", Value: centsToDarajaAmount(input.amountCents) },
                { Key: "TransactionReceipt", Value: input.receipt ?? "SIM0000000" },
                { Key: "ReceiverPartyPublicName", Value: "254700000000 - SIMULATED AGENT" },
              ],
            },
          }
        : {}),
    },
  };
}

/** A funding attempt confirmed by a simulated callback. Returns the attempt's reference. */
export async function simulateConfirmedFunding(input: { clientId: string; amountCents: number; actorId: string; at?: Date }): Promise<string> {
  const at = input.at ?? new Date();
  const reference = newReference();
  const checkoutRequestId = `ws_CO_SIM_${reference}`;
  await prisma.fundingAttempt.create({
    data: {
      reference,
      clientId: input.clientId,
      requestedById: input.actorId,
      amountCents: input.amountCents,
      payerMsisdn: "0700000000",
      status: "pending",
      sendCount: 1,
      checkoutRequestId,
      merchantRequestId: "simulated",
      nextAttemptAt: at,
      createdAt: at,
    },
  });
  await handleCallback({ kind: "stk", reference, payload: stkSuccessBody(checkoutRequestId, input.amountCents, simulatedReceipt()), at });
  return reference;
}
