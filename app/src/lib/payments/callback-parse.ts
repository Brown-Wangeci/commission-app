import { z } from "zod";
import { darajaAmountToCents } from "./amount";
import { redactText } from "./redact";

/**
 * Reads Daraja's callback bodies into one plain shape. Only the fields this
 * system uses are read, so a phone number or a name in the body goes no
 * further. A body that does not parse returns null and changes nothing.
 */
export type ParsedResult = {
  resultCode: string;
  resultDesc: string;
  receipt: string | null;
  amountCents: number | null;
  checkoutRequestId: string | null;
  conversationId: string | null;
  /** The instruction a status result is about, which is not the query's own id. */
  originalReference: string | null;
  /** Completed, Declined, Cancelled, Expired and so on, from a status result. */
  transactionStatus: string | null;
};

const code = z.union([z.number(), z.string()]).transform(String);
const text = z.string().optional();

const stkSchema = z.object({
  Body: z.object({
    stkCallback: z.object({
      CheckoutRequestID: z.string(),
      ResultCode: code,
      ResultDesc: text,
      CallbackMetadata: z.object({ Item: z.array(z.object({ Name: z.string(), Value: z.unknown().optional() })) }).optional(),
    }),
  }),
});

const pair = z.object({ Key: z.string(), Value: z.unknown().optional() });

const resultSchema = z.object({
  Result: z.object({
    ResultCode: code,
    ResultDesc: text,
    ConversationID: text,
    TransactionID: text,
    ResultParameters: z.object({ ResultParameter: z.union([z.array(pair), pair]).optional() }).optional(),
  }),
});

function valueOf(items: ReadonlyArray<{ value: unknown; name: string }>, name: string): unknown {
  return items.find((item) => item.name === name)?.value;
}

function textValue(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function blank(resultCode: string, resultDesc: string | undefined): ParsedResult {
  return {
    resultCode,
    resultDesc: redactText(resultDesc ?? "").slice(0, 300),
    receipt: null,
    amountCents: null,
    checkoutRequestId: null,
    conversationId: null,
    originalReference: null,
    transactionStatus: null,
  };
}

export function parseStkCallback(body: unknown): ParsedResult | null {
  const parsed = stkSchema.safeParse(body);
  if (!parsed.success) return null;
  const callback = parsed.data.Body.stkCallback;
  const items = (callback.CallbackMetadata?.Item ?? []).map((item) => ({ name: item.Name, value: item.Value }));
  return {
    ...blank(callback.ResultCode, callback.ResultDesc),
    checkoutRequestId: callback.CheckoutRequestID,
    receipt: textValue(valueOf(items, "MpesaReceiptNumber")),
    amountCents: darajaAmountToCents(valueOf(items, "Amount")),
  };
}

function resultItems(parameters: z.infer<typeof resultSchema>["Result"]["ResultParameters"]): Array<{ name: string; value: unknown }> {
  const raw = parameters?.ResultParameter;
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return list.map((item) => ({ name: item.Key, value: item.Value }));
}

/** The result of the payment itself, delivered to its ResultURL. */
export function parseB2cResult(body: unknown): ParsedResult | null {
  const parsed = resultSchema.safeParse(body);
  if (!parsed.success) return null;
  const result = parsed.data.Result;
  const items = resultItems(result.ResultParameters);
  return {
    ...blank(result.ResultCode, result.ResultDesc),
    conversationId: result.ConversationID ?? null,
    receipt: textValue(valueOf(items, "TransactionReceipt")) ?? result.TransactionID ?? null,
    amountCents: darajaAmountToCents(valueOf(items, "TransactionAmount")),
  };
}

/** The answer to a Transaction Status query. Its own ids belong to the query, not the payment. */
export function parseStatusResult(body: unknown): ParsedResult | null {
  const parsed = resultSchema.safeParse(body);
  if (!parsed.success) return null;
  const result = parsed.data.Result;
  const items = resultItems(result.ResultParameters);
  return {
    ...blank(result.ResultCode, result.ResultDesc),
    receipt: textValue(valueOf(items, "ReceiptNo")),
    amountCents: darajaAmountToCents(valueOf(items, "Amount")),
    originalReference: textValue(valueOf(items, "OriginatorConversationID")),
    transactionStatus: textValue(valueOf(items, "TransactionStatus")),
  };
}
