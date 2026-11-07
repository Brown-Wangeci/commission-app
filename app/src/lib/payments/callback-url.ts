import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mpesaCredentials } from "./credentials";

/**
 * Callback URLs (IR-02). Daraja does not sign its callbacks, so each
 * instruction is given its own URL carrying an HMAC of the instruction's
 * reference. Only this server can produce that signature, so a request to a
 * URL with a valid signature was sent to an address issued to Daraja for that
 * one instruction, and a leaked URL exposes one instruction, not all of them.
 *
 * The signing key is derived from MPESA_CONSUMER_SECRET under its own label,
 * so the secret itself is never used directly and no further variable is
 * needed. The host is not part of the signature: a tunnel's URL changes on
 * every restart and the signature must not depend on it.
 *
 * References and signatures are hexadecimal because Daraja's URL rules forbid
 * words such as "exec", "cmd" and "query", which a random alphanumeric string
 * could spell. For the same reason the route is /api/payments, not /api/mpesa.
 */
export const CALLBACK_KINDS = ["stk", "b2c-result", "b2c-timeout", "status-result", "status-timeout"] as const;
export type CallbackKind = (typeof CALLBACK_KINDS)[number];

const SIGNING_KEY_LABEL = "ledgerfield-callback-signing-v1";

export function isCallbackKind(value: string): value is CallbackKind {
  return (CALLBACK_KINDS as readonly string[]).includes(value);
}

export function newReference(): string {
  return randomBytes(16).toString("hex");
}

function signature(kind: CallbackKind, reference: string, consumerSecret: string): string {
  const key = createHmac("sha256", consumerSecret).update(SIGNING_KEY_LABEL).digest();
  return createHmac("sha256", key).update(`${kind}:${reference}`).digest("hex");
}

export function callbackUrl(kind: CallbackKind, reference: string): string {
  const credentials = mpesaCredentials();
  if (!credentials) throw new Error("M-Pesa is not configured.");
  const { MPESA_CALLBACK_BASE_URL, MPESA_CONSUMER_SECRET } = credentials;
  return `${MPESA_CALLBACK_BASE_URL}/api/payments/callback/${kind}/${reference}/${signature(kind, reference, MPESA_CONSUMER_SECRET)}`;
}

/** Constant-time check of a URL's signature. False if no secret is set. */
export function callbackSignatureValid(kind: CallbackKind, reference: string, given: string): boolean {
  const secret = process.env.MPESA_CONSUMER_SECRET;
  if (!secret) return false;
  const expected = Buffer.from(signature(kind, reference, secret));
  const actual = Buffer.from(given);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
