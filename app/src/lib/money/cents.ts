/**
 * Money is an integer number of Kenyan Shilling cents everywhere in the
 * application (NFR-07, DR-08, issue #40). This module is the one place an
 * amount is parsed from text or formatted for display, and it does both with
 * string and integer operations only. Nothing here divides, rounds or holds a
 * fraction of a cent, and every function refuses a value that is not a safe
 * integer rather than pass it on.
 */

/** The largest amount one database row can hold: a PostgreSQL INTEGER. */
export const MAX_ROW_CENTS = 2_147_483_647;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/**
 * A whole, non-negative number of cents. Totals (a client's deposits over
 * time) may exceed one record; they only have to stay exact, which a safe
 * integer guarantees.
 */
export function assertTotalCents(value: number, label = "total"): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MoneyError(`${label} must be a whole number of cents, zero or more (got ${String(value)}).`);
  }
  return value;
}

/** A whole, non-negative number of cents that fits in one database row. */
export function assertCents(value: number, label = "amount"): number {
  assertTotalCents(value, label);
  if (value > MAX_ROW_CENTS) {
    throw new MoneyError(`${label} is larger than one record can hold (${formatCents(MAX_ROW_CENTS)}).`);
  }
  return value;
}

function exact(total: bigint, label: string): number {
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MoneyError(`${label} is too large to hold exactly.`);
  }
  return Number(total);
}

/** The exact sum of amounts. */
export function sumCents(values: readonly number[], label = "total"): number {
  return exact(values.reduce((sum, value) => sum + BigInt(assertTotalCents(value, label)), 0n), label);
}

/** a - b, exactly. The result may be negative (a shortfall). */
export function differenceCents(a: number, b: number, label = "difference"): number {
  return exact(BigInt(assertTotalCents(a, label)) - BigInt(assertTotalCents(b, label)), label);
}

/** count x amount, exactly. */
export function multiplyCents(cents: number, count: number, label = "amount"): number {
  if (!Number.isSafeInteger(count) || count < 0) throw new MoneyError(`count must be a whole number (got ${String(count)}).`);
  const product = BigInt(assertCents(cents)) * BigInt(count);
  if (product > BigInt(MAX_ROW_CENTS)) {
    throw new MoneyError(`${label} is larger than one record can hold (${formatCents(MAX_ROW_CENTS)}).`);
  }
  return Number(product);
}

const KSH_TEXT = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

/**
 * "1,500", "1500.5" or "KSh 1,500.50" as cents (150050). Returns null for
 * anything else, including more than two decimal places: a fraction of a
 * cent is refused, never rounded.
 */
export function parseKshToCents(text: string): number | null {
  const cleaned = text.trim().replace(/^ksh\s*/i, "").replace(/\s+/g, "");
  const match = KSH_TEXT.exec(cleaned);
  if (!match) return null;
  const shillings = match[1].replace(/,/g, "");
  const fraction = (match[2] ?? "").padEnd(2, "0");
  const cents = BigInt(shillings) * 100n + BigInt(fraction);
  return cents > BigInt(MAX_ROW_CENTS) ? null : Number(cents);
}

const PERCENT_TEXT = /^(\d{1,3})(?:\.(\d{1,2}))?$/;

/** "8.25" (per cent) as 825 basis points. Null for anything else or above 100%. */
export function parsePercentToBps(text: string): number | null {
  const match = PERCENT_TEXT.exec(text.trim().replace(/%$/, "").trim());
  if (!match) return null;
  const bps = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return bps > 10_000 ? null : bps;
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Splits cents into whole-shilling digits and the two cent digits, as text. */
function splitDigits(cents: number): { shillings: string; cents: string } {
  const digits = String(cents).padStart(3, "0");
  return { shillings: digits.slice(0, -2), cents: digits.slice(-2) };
}

/**
 * "KSh 4,750.00", as the design system writes money: currency prefix,
 * thousands separators, two decimals, and a true minus sign (U+2212) for a
 * negative amount such as a shortfall.
 */
export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new MoneyError(`Cannot format ${String(cents)} as money.`);
  const parts = splitDigits(Math.abs(cents));
  return `KSh ${cents < 0 ? "−" : ""}${groupThousands(parts.shillings)}.${parts.cents}`;
}

/** "1500.50": cents as plain shillings text, for form inputs. */
export function centsToKshText(cents: number): string {
  const parts = splitDigits(assertCents(cents));
  return `${parts.shillings}.${parts.cents}`;
}

/** 825 basis points as "8.25%". */
export function formatBps(bps: number): string {
  if (!Number.isSafeInteger(bps) || bps < 0) throw new MoneyError(`Cannot format ${String(bps)} as a rate.`);
  const parts = splitDigits(bps);
  return `${parts.shillings}.${parts.cents}%`;
}
