import { NextRequest } from "next/server";
import { POST } from "@/app/api/payments/callback/[kind]/[reference]/[signature]/route";
import { callbackUrl, type CallbackKind } from "@/lib/payments/callback-url";

/** The bodies Daraja's documentation shows, with the values a test needs. */
export function stkSuccess(checkoutRequestId: string, amount: number | string, receipt = "NLJ7RT61SV") {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: "29115-34620561-1",
        CheckoutRequestID: checkoutRequestId,
        ResultCode: 0,
        ResultDesc: "The service request is processed successfully.",
        CallbackMetadata: {
          Item: [
            { Name: "Amount", Value: amount },
            { Name: "MpesaReceiptNumber", Value: receipt },
            { Name: "TransactionDate", Value: 20191219102115 },
            { Name: "PhoneNumber", Value: 254708374149 },
          ],
        },
      },
    },
  };
}

export function stkCancelled(checkoutRequestId: string) {
  return { Body: { stkCallback: { MerchantRequestID: "f1e2-4b95", CheckoutRequestID: checkoutRequestId, ResultCode: 1032, ResultDesc: "Request cancelled by user" } } };
}

export function b2cSuccess(input: { reference: string; conversationId: string; amount: number | string; receipt?: string }) {
  const receipt = input.receipt ?? "SG632NMUAB";
  return {
    Result: {
      ResultType: 0,
      ResultCode: 0,
      ResultDesc: "The service request is processed successfully.",
      OriginatorConversationID: input.reference,
      ConversationID: input.conversationId,
      TransactionID: receipt,
      ResultParameters: {
        ResultParameter: [
          { Key: "TransactionAmount", Value: input.amount },
          { Key: "TransactionReceipt", Value: receipt },
          { Key: "ReceiverPartyPublicName", Value: "254705912645 - NICHOLAS JOHN SONGOK" },
          { Key: "TransactionCompletedDateTime", Value: "06.07.2024 22:48:52" },
          { Key: "B2CRecipientIsRegisteredCustomer", Value: "Y" },
        ],
      },
      ReferenceData: { ReferenceItem: { Key: "QueueTimeoutURL", Value: "https://internalsandbox.safaricom.co.ke/mpesa/b2cresults/v1/submit" } },
    },
  };
}

export function b2cFailure(input: { reference: string; conversationId: string; resultCode?: number; resultDesc?: string }) {
  return {
    Result: {
      ResultType: 0,
      ResultCode: input.resultCode ?? 2001,
      ResultDesc: input.resultDesc ?? "The initiator information is invalid.",
      OriginatorConversationID: input.reference,
      ConversationID: input.conversationId,
      TransactionID: "SG722NMVXQ",
    },
  };
}

export function statusResult(input: { reference: string; status: string; amount?: string; receipt?: string; resultCode?: number; resultDesc?: string }) {
  return {
    Result: {
      ConversationID: "AG_QUERY_OWN_ID",
      OriginatorConversationID: "query-own-id",
      ResultCode: input.resultCode ?? 0,
      ResultDesc: input.resultDesc ?? "The service request is processed successfully.",
      ResultType: 0,
      TransactionID: "MBN0000000",
      ResultParameters: {
        ResultParameter: [
          { Key: "OriginatorConversationID", Value: input.reference },
          { Key: "TransactionStatus", Value: input.status },
          { Key: "Amount", Value: input.amount ?? "300" },
          { Key: "ReceiptNo", Value: input.receipt ?? "MBN31H462N" },
        ],
      },
    },
  };
}

function segmentsOf(kind: CallbackKind, reference: string) {
  const parts = new URL(callbackUrl(kind, reference)).pathname.split("/");
  return { kind: parts[4], reference: parts[5], signature: parts[6] };
}

/** Delivers a body to the real route handler, as Daraja would, at the signed URL. */
export function deliver(kind: CallbackKind, reference: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return deliverTo(segmentsOf(kind, reference), typeof body === "string" ? body : JSON.stringify(body), headers);
}

export function deliverTo(params: { kind: string; reference: string; signature: string }, body: string, headers: Record<string, string> = {}): Promise<Response> {
  const url = `https://callbacks.test/api/payments/callback/${params.kind}/${params.reference}/${params.signature}`;
  const request = new NextRequest(url, { method: "POST", body, headers: { "Content-Type": "application/json", ...headers } });
  return POST(request, { params: Promise.resolve(params) });
}
