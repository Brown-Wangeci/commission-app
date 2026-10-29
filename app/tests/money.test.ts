import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertCents,
  centsToKshText,
  differenceCents,
  formatBps,
  formatCents,
  MAX_ROW_CENTS,
  multiplyCents,
  parseKshToCents,
  parsePercentToBps,
  sumCents,
} from "@/lib/money/cents";
import { commissionDerivation, computeCommission, maxLiability } from "@/lib/money/commission";

/** A small deterministic generator, so the property checks are repeatable. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

describe("commission calculation and rounding (FR-18, issue #41)", () => {
  const commission = (submissionValueCents: number, commissionRateBps: number, flatCommissionCents = 0) =>
    computeCommission({ submissionValueCents, commissionRateBps, flatCommissionCents });

  it("applies value x rate / 10000, floored, plus the flat amount", () => {
    expect(commission(300_000, 1000)).toMatchObject({ rateComponentCents: 30_000, amountCents: 30_000, roundedDown: false });
    expect(commission(250_000, 1200, 5_000)).toMatchObject({ rateComponentCents: 30_000, amountCents: 35_000 });
    expect(commission(123_456, 825, 2_000)).toMatchObject({ rateComponentCents: 10_185, amountCents: 12_185, roundedDown: true });
  });

  it("floors at the boundary between cents, never rounds up", () => {
    // 9,999 x 1 = 9,999 / 10000 = 0.9999 cents -> 0.
    expect(commission(9_999, 1).rateComponentCents).toBe(0);
    // 10,000 x 1 = 1 cent exactly.
    expect(commission(10_000, 1)).toMatchObject({ rateComponentCents: 1, roundedDown: false });
    // 10,001 x 1 = 1.0001 -> 1.
    expect(commission(10_001, 1)).toMatchObject({ rateComponentCents: 1, roundedDown: true });
    // 19,999 x 1 = 1.9999 -> 1: just below the next cent.
    expect(commission(19_999, 1).rateComponentCents).toBe(1);
    // 333 x 3000 = 99.9 -> 99; 334 x 3000 = 100.2 -> 100.
    expect(commission(333, 3000).rateComponentCents).toBe(99);
    expect(commission(334, 3000).rateComponentCents).toBe(100);
    // KSh 2,333.33 x 12% = 279.9996 -> KSh 279.99, as in the seed's Githurai job.
    expect(commission(233_333, 1200)).toMatchObject({ rateComponentCents: 27_999, roundedDown: true });
  });

  it("handles the ends of the rate range", () => {
    expect(commission(123_457, 10_000)).toMatchObject({ rateComponentCents: 123_457, roundedDown: false });
    expect(commission(1, 1)).toMatchObject({ rateComponentCents: 0, amountCents: 0, roundedDown: true });
    expect(() => commission(100, 0)).toThrow(/basis points from 1/);
    expect(() => commission(100, 10_001)).toThrow(/basis points from 1/);
  });

  it("is exact at the largest amount a record can hold", () => {
    expect(commission(MAX_ROW_CENTS, 10_000).amountCents).toBe(MAX_ROW_CENTS);
    // 2,147,483,647 x 9,999 = 21,472,688,986,353 (above 2^44), / 10000 = 2,147,268,898.6353 -> 2,147,268,898.
    expect(commission(MAX_ROW_CENTS, 9_999).rateComponentCents).toBe(2_147_268_898);
    expect(() => commission(MAX_ROW_CENTS, 10_000, 1)).toThrow(/larger than one record/);
  });

  it("satisfies the floor definition for 20,000 random structures: r x 10000 <= v x b < (r + 1) x 10000", () => {
    const next = generator(20261029);
    for (let i = 0; i < 20_000; i += 1) {
      const value = next() % MAX_ROW_CENTS;
      const bps = (next() % 10_000) + 1;
      const flat = next() % 1_000_000;
      let result;
      try {
        result = commission(value, bps, flat);
      } catch {
        continue; // value x rate + flat did not fit in a record: correctly refused
      }
      const exact = BigInt(value) * BigInt(bps);
      const rate = BigInt(result.rateComponentCents);
      expect(rate * 10_000n <= exact && exact < (rate + 1n) * 10_000n, `${value} x ${bps}`).toBe(true);
      expect(result.amountCents).toBe(result.rateComponentCents + flat);
      expect(result.roundedDown).toBe(exact % 10_000n !== 0n);
      expect(Number.isSafeInteger(result.amountCents)).toBe(true);
    }
  });

  it("refuses anything that is not a whole number of cents", () => {
    for (const bad of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, 0.1 + 0.2]) {
      expect(() => commission(bad, 1000), String(bad)).toThrow();
      expect(() => commission(100_000, 1000, bad), String(bad)).toThrow();
    }
    expect(() => commission(100_000, 12.5)).toThrow();
  });

  it("computes the maximum liability exactly, and refuses one too large for a record", () => {
    expect(maxLiability({ submissionValueCents: 123_456, commissionRateBps: 825, flatCommissionCents: 2_000 }, 7).amountCents).toBe(7 * 12_185);
    expect(() => maxLiability({ submissionValueCents: 350_000_000, commissionRateBps: 10_000, flatCommissionCents: 0 }, 10_000)).toThrow(/larger than one record/);
  });

  it("writes the derivation line the design system requires", () => {
    expect(commissionDerivation(commission(300_000, 1000))).toBe("KSh 3,000.00 × 10.00% = KSh 300.00");
    expect(commissionDerivation(commission(123_456, 825, 2_000))).toBe("KSh 1,234.56 × 8.25% = KSh 101.85 (rounded down to the cent) + KSh 20.00 flat");
  });
});

describe("integer-only money arithmetic (NFR-07, issue #40)", () => {
  it("parses shillings text to cents without floating point, and refuses fractions of a cent", () => {
    expect(parseKshToCents("1500")).toBe(150_000);
    expect(parseKshToCents("1,500.5")).toBe(150_050);
    expect(parseKshToCents("KSh 1,234,567.89")).toBe(123_456_789);
    expect(parseKshToCents("0.07")).toBe(7);
    // 0.29 x 100 is 28.999999999999996 in floating point; text parsing gives 29.
    expect(parseKshToCents("0.29")).toBe(29);
    expect(parseKshToCents("1.005")).toBeNull();
    expect(parseKshToCents("-5")).toBeNull();
    expect(parseKshToCents("1e3")).toBeNull();
    expect(parseKshToCents("12,34")).toBeNull();
    expect(parseKshToCents("21474836.48")).toBeNull();
  });

  it("parses a percentage to basis points without floating point", () => {
    // parseFloat("8.15") * 100 is 815.0000000000001.
    expect(parsePercentToBps("8.15")).toBe(815);
    expect(parsePercentToBps("10")).toBe(1000);
    expect(parsePercentToBps("0.01")).toBe(1);
    expect(parsePercentToBps("100")).toBe(10_000);
    expect(parsePercentToBps("100.01")).toBeNull();
    expect(parsePercentToBps("8.125")).toBeNull();
  });

  it("formats cents in full with two decimals and a true minus sign", () => {
    expect(formatCents(475_000)).toBe("KSh 4,750.00");
    expect(formatCents(5)).toBe("KSh 0.05");
    expect(formatCents(0)).toBe("KSh 0.00");
    expect(formatCents(-5_000)).toBe("KSh −50.00");
    expect(formatCents(MAX_ROW_CENTS)).toBe("KSh 21,474,836.47");
    expect(centsToKshText(150_050)).toBe("1500.50");
    expect(formatBps(825)).toBe("8.25%");
    expect(formatBps(10_000)).toBe("100.00%");
    expect(() => formatCents(1.5)).toThrow();
  });

  it("round-trips every cent value through text exactly", () => {
    const next = generator(7);
    for (let i = 0; i < 5_000; i += 1) {
      const cents = next() % MAX_ROW_CENTS;
      expect(parseKshToCents(centsToKshText(cents))).toBe(cents);
      expect(parseKshToCents(formatCents(cents))).toBe(cents);
    }
  });

  it("adds, subtracts and multiplies exactly, and refuses non-integers", () => {
    expect(sumCents([1, 2, 3])).toBe(6);
    expect(sumCents([MAX_ROW_CENTS, MAX_ROW_CENTS])).toBe(2 * MAX_ROW_CENTS);
    expect(differenceCents(100, 250)).toBe(-150);
    expect(multiplyCents(12_185, 4)).toBe(48_740);
    expect(() => multiplyCents(MAX_ROW_CENTS, 2)).toThrow(/larger than one record/);
    expect(() => sumCents([1, 0.5])).toThrow(/whole number of cents/);
    expect(() => differenceCents(1.25, 1)).toThrow(/whole number of cents/);
    expect(() => assertCents(MAX_ROW_CENTS + 1)).toThrow(/larger than one record/);
  });

  it("uses no floating point operation anywhere in the money path's source", () => {
    // The modules that hold, move or compute money. Any of these constructs
    // could create or round a fraction; none may appear outside comments.
    const files = [
      "src/lib/money/cents.ts",
      "src/lib/money/commission.ts",
      "src/lib/escrow/holds.ts",
      "src/lib/escrow/client.ts",
      "src/lib/payouts/amount.ts",
      "src/lib/payouts/authorise.ts",
      "src/lib/payouts/boundary.ts",
      "src/lib/payouts/commissions.ts",
      "src/lib/payouts/noop.ts",
    ];
    const forbidden = [
      /parseFloat/,
      /toFixed\(/,
      /Math\.(round|floor|ceil|trunc|fround)\b/,
      /\b\d+\.\d+\b/, // a decimal literal
      /[\w)\]]\s*\/\s*(?!BigInt\(|\d[\d_]*n\b)[\w(]/, // a division, unless of BigInts (exact integer division)
      /\bDecimal\b/,
      /\bnumber\(\)\.(?!int)/, // a zod number that is not an integer
    ];
    for (const file of files) {
      const source = fs
        .readFileSync(path.resolve(__dirname, "..", file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "")
        .replace(/`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')
        .replace(/\/(?![*/])(?:[^/\\\n]|\\.)+\/[dgimsuy]*/g, "/re/");
      for (const pattern of forbidden) {
        expect(pattern.test(source), `${file} contains ${pattern}`).toBe(false);
      }
    }
  });
});
