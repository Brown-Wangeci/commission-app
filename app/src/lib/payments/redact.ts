import { secretValues } from "./credentials";

/**
 * Keeps credentials out of logs, error messages, stored failure reasons and
 * the evidence files (E1). Used on everything that leaves this module's
 * payment code as text.
 */
const SECRET_KEY = /^(securitycredential|password|authorization|access_token|consumer_?key|consumer_?secret|passkey|initiatorname|initiator)$/i;
const PHONE_KEY = /^(partya|partyb|phonenumber|msisdn|payermsisdn|payoutmsisdn)$/i;
const NAME_KEY = /^(receiverpartypublicname|debitpartyname|creditpartyname)$/i;
const URL_KEY = /^(callbackurl|resulturl|queuetimeouturl)$/i;

const REDACTED = "[redacted]";

/** Keeps the country code and last three digits; shortcodes are left alone. */
export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 9) return value;
  return `${digits.slice(0, digits.startsWith("254") ? 4 : 2)}${"*".repeat(6)}${digits.slice(-3)}`;
}

/** Removes the signature from a callback URL, keeping the rest readable. */
export function maskCallbackUrl(url: string): string {
  return url.replace(/(\/api\/payments\/callback\/[^/]+\/[^/]+\/)[0-9a-f]+/gi, `$1${REDACTED}`);
}

/** Scrubs free text: known secret values, bearer and basic tokens, signed URLs, phone numbers. */
export function redactText(text: string): string {
  const withoutSecrets = secretValues().reduce((current, secret) => current.split(secret).join(REDACTED), text);
  return maskCallbackUrl(withoutSecrets)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._-]+/gi, `$1 ${REDACTED}`)
    .replace(/\b(?:254|0)[17]\d{8}\b/g, maskPhone);
}

function redactNamed(value: string): string {
  const number = /^\s*(\d{9,12})\s*-/.exec(value);
  return number ? `${maskPhone(number[1])} - ${REDACTED}` : REDACTED;
}

function redactEntry(key: string, value: unknown): unknown {
  if (SECRET_KEY.test(key)) return REDACTED;
  if (typeof value === "string" || typeof value === "number") {
    if (PHONE_KEY.test(key)) return maskPhone(String(value));
    if (NAME_KEY.test(key)) return redactNamed(String(value));
    if (URL_KEY.test(key)) return maskCallbackUrl(String(value));
  }
  return redactPayload(value);
}

/** Daraja lists results as {Key|Name, Value} pairs, so the key is in the data. */
function redactPair(pair: Record<string, unknown>): Record<string, unknown> {
  const key = typeof pair.Key === "string" ? pair.Key : typeof pair.Name === "string" ? pair.Name : null;
  if (key === null || !("Value" in pair)) return redactObject(pair);
  return { ...pair, Value: redactEntry(key, pair.Value) };
}

function redactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactEntry(key, entry)]));
}

/** A deep copy of a Daraja payload that is safe to store or commit. */
export function redactPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPayload);
  if (value === null || typeof value !== "object") return typeof value === "string" ? redactText(value) : value;
  return redactPair(value as Record<string, unknown>);
}
