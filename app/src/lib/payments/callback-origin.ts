import { config } from "@/lib/config";
import { callbackSignatureValid, type CallbackKind } from "./callback-url";

/**
 * Decides whether a callback came from where this server sent it (IR-02).
 *
 * The signature in the URL is the check that counts. The source address list
 * is a second, optional check: Safaricom's addresses are not stated in the
 * Daraja documentation, so the list is empty by default and is filled from
 * addresses the deployment has confirmed. It reads X-Forwarded-For, which only
 * means something behind a proxy that sets it, so it adds to the signature and
 * never replaces it.
 */
export type OriginCheck = { kind: CallbackKind; reference: string; signature: string; sourceIp: string | null };

export function originVerified(check: OriginCheck): boolean {
  if (!callbackSignatureValid(check.kind, check.reference, check.signature)) return false;
  return sourceAllowed(check.sourceIp, config().MPESA_CALLBACK_ALLOWED_IPS);
}

export function sourceAllowed(sourceIp: string | null, allowList: string): boolean {
  const entries = allowList.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) return true;
  if (!sourceIp) return false;
  return entries.some((entry) => matches(sourceIp, entry));
}

function matches(ip: string, entry: string): boolean {
  if (!entry.includes("/")) return ip === entry;
  const [network, bits] = entry.split("/");
  const address = ipv4ToNumber(ip);
  const base = ipv4ToNumber(network);
  const prefix = Number(bits);
  if (address === null || base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) >>> 0 === (base & mask) >>> 0;
}

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((total, part) => total * 256 + Number(part), 0);
}

/** The address the nearest proxy recorded: the last X-Forwarded-For entry. */
export function sourceIpOf(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (!forwarded) return null;
  return forwarded.split(",").at(-1)?.trim().replace(/^::ffff:/, "") || null;
}
