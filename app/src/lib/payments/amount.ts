import { config } from "@/lib/config";
import { centsToKshText, formatCents, parseKshToCents } from "@/lib/money/cents";

/**
 * The Daraja money boundary (B2). The platform works in integer cents
 * everywhere; this is the only place cents become Daraja's shilling amounts,
 * and the conversion is exact in both directions. Nothing is ever rounded: an
 * amount that cannot be sent exactly is refused and reported.
 */
type Limits = { minCents: number; maxCents: number };

function problem(cents: number, limits: Limits, wholeOnly: boolean): string | null {
  if (cents < limits.minCents) return `${formatCents(cents)} is below the M-Pesa minimum of ${formatCents(limits.minCents)}.`;
  if (cents > limits.maxCents) return `${formatCents(cents)} is above the M-Pesa maximum of ${formatCents(limits.maxCents)}.`;
  if (wholeOnly && !centsToKshText(cents).endsWith(".00")) {
    return `${formatCents(cents)} includes cents, and M-Pesa is set to take whole shillings only. It was not rounded.`;
  }
  return null;
}

/** Why an STK Push of this amount cannot be sent, or null if it can. */
export function stkAmountProblem(cents: number): string | null {
  const { MPESA_STK_MIN_CENTS, MPESA_STK_MAX_CENTS, MPESA_WHOLE_SHILLINGS_ONLY } = config();
  return problem(cents, { minCents: MPESA_STK_MIN_CENTS, maxCents: MPESA_STK_MAX_CENTS }, MPESA_WHOLE_SHILLINGS_ONLY);
}

/** Why a B2C payment of this amount cannot be sent, or null if it can. */
export function b2cAmountProblem(cents: number): string | null {
  const { MPESA_B2C_MIN_CENTS, MPESA_B2C_MAX_CENTS, MPESA_WHOLE_SHILLINGS_ONLY } = config();
  return problem(cents, { minCents: MPESA_B2C_MIN_CENTS, maxCents: MPESA_B2C_MAX_CENTS }, MPESA_WHOLE_SHILLINGS_ONLY);
}

/** Integer cents as Daraja's Amount text: 30000 is "300", 27999 is "279.99". */
export function centsToDarajaAmount(cents: number): string {
  const text = centsToKshText(cents);
  return text.endsWith(".00") ? text.slice(0, -3) : text;
}

/** Daraja's Amount (a number or text, such as 1.00 or "300") as integer cents, or null. */
export function darajaAmountToCents(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  return parseKshToCents(String(value));
}
