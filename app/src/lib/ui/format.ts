import { parseKshToCents } from "@/lib/money/cents";

/**
 * Display formatting for form inputs. Each keeps to a form the server
 * already accepts, so none changes what is validated or stored:
 * kenyanMsisdnSchema (src/lib/validation.ts) and the evidence phone check
 * strip spaces and hyphens, and parseKshToCents accepts thousands separators.
 */

/** Groups a Kenyan mobile number as it is typed: 0712 345 678, or +254 712 345 678. */
export function groupPhone(raw: string): string {
  const plus = raw.trim().startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (digits === "") return plus ? "+" : "";
  if (digits.startsWith("254")) {
    const rest = digits.slice(3, 12);
    return [`${plus ? "+" : ""}254`, rest.slice(0, 3), rest.slice(3, 6), rest.slice(6, 9)].filter(Boolean).join(" ");
  }
  const local = digits.slice(0, 10);
  return [local.slice(0, 4), local.slice(4, 7), local.slice(7, 10)].filter(Boolean).join(" ");
}

/** 1234567 -> "1,234,567". */
function thousands(whole: number): string {
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Shillings regrouped once the field is left: "5000" -> "5,000",
 * "2500.5" -> "2,500.50". Anything the parser refuses is left exactly as
 * typed, so the error beside it still refers to what the person entered.
 */
export function groupKsh(raw: string): string {
  const cents = parseKshToCents(raw);
  if (cents === null) return raw;
  const whole = thousands(Math.floor(cents / 100));
  const rest = cents % 100;
  return rest === 0 ? whole : `${whole}.${String(rest).padStart(2, "0")}`;
}
