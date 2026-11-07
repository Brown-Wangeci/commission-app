import { config } from "@/lib/config";
import { toServiceTime } from "@/lib/scoring/time";
import { centsToDarajaAmount } from "./amount";
import { callbackUrl } from "./callback-url";
import { capture } from "./capture";
import { mpesaCredentials, type MpesaCredentials } from "./credentials";
import { redactText } from "./redact";

/**
 * The HTTP client for Daraja. Every call ends in one of four outcomes, and the
 * difference between the last two is what prevents a double payment:
 *
 *   accepted       Daraja took the request.
 *   refused        Daraja answered no. Nothing was processed.
 *   not_delivered  The request never reached Daraja, or Daraja said it could
 *                  not take it. Safe to send again.
 *   unknown        It may have been received, for example a timeout after the
 *                  request left. Must never be sent again automatically.
 */
export type DarajaOutcome<T> =
  | { kind: "accepted"; body: T }
  | { kind: "refused"; reason: string; code: string; retryable: boolean; duplicate: boolean }
  | { kind: "not_delivered"; reason: string }
  | { kind: "unknown"; reason: string };

export type StkAccepted = { MerchantRequestID: string; CheckoutRequestID: string; ResponseDescription?: string };
export type StkQueryAccepted = { ResultCode?: string | number; ResultDesc?: string };
export type B2cAccepted = { ConversationID: string; OriginatorConversationID: string };

const TOKEN_REFRESH_MARGIN_MS = 60_000;
const MAX_REASON_LENGTH = 300;
/** Failures where the connection never opened, so the request cannot have arrived. */
const NEVER_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
/** Documented as "system is busy", "spike arrest" and "internal server error". */
const RETRYABLE_CODE = /^500\.003\./;
const INVALID_TOKEN_CODE = "404.001.03";
const RETRYABLE_MESSAGE = /system is busy|spike arrest|unable to lock subscriber|being processed/i;
const DUPLICATE_MESSAGE = /duplicate originatorconversationid/i;

const HOSTS = { sandbox: "https://sandbox.safaricom.co.ke", production: "https://api.safaricom.co.ke" } as const;

let cachedToken: { key: string; token: string; expiresAt: number } | null = null;

/** MPESA_ENV picks the host. MPESA_BASE_URL overrides it, for the mock in the test suite. */
function darajaBaseUrl(): string {
  const { MPESA_BASE_URL, MPESA_ENV } = config();
  return MPESA_BASE_URL ?? HOSTS[MPESA_ENV];
}

function clean(text: string): string {
  return redactText(text).slice(0, MAX_REASON_LENGTH);
}

function requireCredentials(): MpesaCredentials {
  const credentials = mpesaCredentials();
  if (!credentials) throw new Error("M-Pesa is not configured.");
  return credentials;
}

/** Fetches a token, or reuses one that has not expired. Throws if Daraja refuses. */
async function accessToken(credentials: MpesaCredentials): Promise<string> {
  const { MPESA_TIMEOUT_MS } = config();
  const key = `${darajaBaseUrl()}|${credentials.MPESA_CONSUMER_KEY}`;
  if (cachedToken?.key === key && cachedToken.expiresAt > Date.now()) return cachedToken.token;
  const basic = Buffer.from(`${credentials.MPESA_CONSUMER_KEY}:${credentials.MPESA_CONSUMER_SECRET}`).toString("base64");
  const response = await fetch(`${darajaBaseUrl()}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${basic}` },
    signal: AbortSignal.timeout(MPESA_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Daraja refused the credentials (HTTP ${response.status}).`);
  const body = (await response.json()) as { access_token?: string; expires_in?: string | number };
  if (!body.access_token) throw new Error("Daraja returned no access token.");
  const lifetimeMs = Number(body.expires_in ?? 0) * 1000;
  cachedToken = { key, token: body.access_token, expiresAt: Date.now() + lifetimeMs - TOKEN_REFRESH_MARGIN_MS };
  return body.access_token;
}

function networkFailure(error: unknown): DarajaOutcome<never> {
  const code = (error as { cause?: { code?: string } }).cause?.code;
  if (code && NEVER_SENT.has(code)) return { kind: "not_delivered", reason: `Daraja could not be reached (${code}).` };
  return { kind: "unknown", reason: "Daraja did not answer in time, so it may or may not have received this." };
}

function refusal(code: string, message: string): DarajaOutcome<never> {
  if (code === INVALID_TOKEN_CODE) cachedToken = null;
  const retryable = RETRYABLE_CODE.test(code) || code === INVALID_TOKEN_CODE || RETRYABLE_MESSAGE.test(message);
  return { kind: "refused", reason: clean(message), code, retryable, duplicate: DUPLICATE_MESSAGE.test(message) };
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Turns an HTTP answer into an outcome. Anything unrecognised counts as unknown, never as safe to resend. */
export function classifyResponse<T>(status: number, body: unknown): DarajaOutcome<T> {
  const fields = (body ?? {}) as Record<string, unknown>;
  if (status >= 200 && status < 300 && String(fields.ResponseCode) === "0") return { kind: "accepted", body: fields as T };
  const code = textOf(fields.errorCode) ?? (fields.ResponseCode === undefined ? null : String(fields.ResponseCode));
  if (code !== null) return refusal(code, textOf(fields.errorMessage) ?? textOf(fields.ResponseDescription) ?? `Daraja refused the request (${code}).`);
  if (status === 429 || status === 503) return { kind: "not_delivered", reason: `Daraja is unavailable (HTTP ${status}).` };
  return { kind: "unknown", reason: `Daraja gave no usable answer (HTTP ${status}), so it may or may not have received this.` };
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function post<T>(label: string, path: string, body: Record<string, unknown>): Promise<DarajaOutcome<T>> {
  const credentials = requireCredentials();
  const { MPESA_TIMEOUT_MS } = config();
  let token: string;
  try {
    token = await accessToken(credentials);
  } catch (error) {
    return { kind: "not_delivered", reason: clean(error instanceof Error ? error.message : "Could not get a Daraja token.") };
  }
  capture({ direction: "request", label, payload: body });
  try {
    const response = await fetch(`${darajaBaseUrl()}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(MPESA_TIMEOUT_MS),
    });
    const parsed = await readBody(response);
    capture({ direction: "response", label, status: response.status, payload: parsed });
    return classifyResponse<T>(response.status, parsed);
  } catch (error) {
    return networkFailure(error);
  }
}

/** 0712345678 as Daraja's 254712345678. */
export function toDarajaMsisdn(local: string): string {
  if (!/^0[17]\d{8}$/.test(local)) throw new Error("The number is not a Kenyan mobile number.");
  return `254${local.slice(1)}`;
}

/** Password and timestamp for STK calls: base64(shortcode + passkey + timestamp). */
function stkPassword(credentials: MpesaCredentials, at: Date): { Password: string; Timestamp: string } {
  const Timestamp = toServiceTime(at).replace(/\D/g, "").slice(0, 14);
  const Password = Buffer.from(`${credentials.MPESA_STK_SHORTCODE}${credentials.MPESA_STK_PASSKEY}${Timestamp}`).toString("base64");
  return { Password, Timestamp };
}

export function stkPush(input: { reference: string; amountCents: number; payerMsisdn: string; at: Date }): Promise<DarajaOutcome<StkAccepted>> {
  const credentials = requireCredentials();
  const phone = toDarajaMsisdn(input.payerMsisdn);
  return post<StkAccepted>("stk-push", "/mpesa/stkpush/v1/processrequest", {
    BusinessShortCode: Number(credentials.MPESA_STK_SHORTCODE),
    ...stkPassword(credentials, input.at),
    TransactionType: config().MPESA_STK_TRANSACTION_TYPE,
    Amount: centsToDarajaAmount(input.amountCents),
    PartyA: phone,
    PartyB: credentials.MPESA_STK_SHORTCODE,
    PhoneNumber: phone,
    CallBackURL: callbackUrl("stk", input.reference),
    AccountReference: `LF${input.reference.slice(0, 10)}`,
    TransactionDesc: "Escrow fund",
  });
}

export function stkQuery(input: { checkoutRequestId: string; at: Date }): Promise<DarajaOutcome<StkQueryAccepted>> {
  const credentials = requireCredentials();
  return post<StkQueryAccepted>("stk-status", "/mpesa/stkpushquery/v1/query", {
    BusinessShortCode: credentials.MPESA_STK_SHORTCODE,
    ...stkPassword(credentials, input.at),
    CheckoutRequestID: input.checkoutRequestId,
  });
}

export function b2cPayment(input: { reference: string; amountCents: number; payoutMsisdn: string; remarks: string }): Promise<DarajaOutcome<B2cAccepted>> {
  const credentials = requireCredentials();
  return post<B2cAccepted>("b2c", "/mpesa/b2c/v3/paymentrequest", {
    OriginatorConversationID: input.reference,
    InitiatorName: credentials.MPESA_B2C_INITIATOR_NAME,
    SecurityCredential: credentials.MPESA_B2C_SECURITY_CREDENTIAL,
    CommandID: config().MPESA_B2C_COMMAND_ID,
    Amount: centsToDarajaAmount(input.amountCents),
    PartyA: credentials.MPESA_B2C_SHORTCODE,
    PartyB: toDarajaMsisdn(input.payoutMsisdn),
    Remarks: input.remarks,
    QueueTimeOutURL: callbackUrl("b2c-timeout", input.reference),
    ResultURL: callbackUrl("b2c-result", input.reference),
  });
}

/** Asks where a B2C instruction stands. The answer arrives later, at the status callback. */
export function transactionStatus(input: { reference: string }): Promise<DarajaOutcome<B2cAccepted>> {
  const credentials = requireCredentials();
  return post<B2cAccepted>("b2c-status", "/mpesa/transactionstatus/v1/query", {
    Initiator: credentials.MPESA_B2C_INITIATOR_NAME,
    SecurityCredential: credentials.MPESA_B2C_SECURITY_CREDENTIAL,
    CommandID: "TransactionStatusQuery",
    OriginalConversationID: input.reference,
    PartyA: credentials.MPESA_B2C_SHORTCODE,
    IdentifierType: "4",
    ResultURL: callbackUrl("status-result", input.reference),
    QueueTimeOutURL: callbackUrl("status-timeout", input.reference),
    Remarks: "Status check",
    Occasion: "Status check",
  });
}
