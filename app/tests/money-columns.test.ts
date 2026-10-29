import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { MONEY_NAME, moneyColumnViolations, NOT_MONEY, schemaFields } from "@/lib/money/schema-check";

const SCHEMA = fs.readFileSync(path.resolve(__dirname, "../prisma/schema.prisma"), "utf8");

describe("money column build check (NFR-07, DR-08, issue #40)", () => {
  it("passes the real schema: no Float or Decimal money, every money column integer cents", () => {
    expect(moneyColumnViolations(SCHEMA)).toEqual([]);
  });

  it("names every money column in the schema with its unit", () => {
    const money = schemaFields(SCHEMA).filter((f) => ["Int", "BigInt", "Float", "Decimal"].includes(f.type) && MONEY_NAME.test(f.field));
    expect(money.length).toBeGreaterThanOrEqual(10);
    for (const f of money) expect(`${f.model}.${f.field}`).toMatch(/(Cents|Bps)$/);
  });

  it("fails a Float or Decimal money column, a money column named in shillings, and an undeclared Float", () => {
    const bad = `
model Payout {
  id          String  @id
  amount      Float
  feeKsh      Int
  price       Decimal
  balanceCents Float
  weightKg    Float
  amountCents Int
}`;
    const violations = moneyColumnViolations(bad);
    expect(violations).toHaveLength(5);
    for (const field of ["Payout.amount", "Payout.feeKsh", "Payout.price", "Payout.balanceCents", "Payout.weightKg"]) {
      expect(violations.some((v) => v.startsWith(field)), field).toBe(true);
    }
    expect(violations.some((v) => v.startsWith("Payout.amountCents"))).toBe(false);
  });

  it("fails the old schema's money columns", () => {
    const old = `
model Job {
  payoutPerActivationKsh Int
  commissionRate         Float
}
model CustomerActivityDay {
  topupAmountKsh Float
}`;
    expect(moneyColumnViolations(old)).toHaveLength(3);
  });

  it("finds the same thing in the migrated database: integers for money, fractions only where declared", async () => {
    const columns = await prisma.$queryRaw<{ table_name: string; column_name: string; data_type: string }[]>`
      SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type IN ('integer', 'bigint', 'smallint', 'double precision', 'real', 'numeric')`;
    expect(columns.length).toBeGreaterThan(0);
    for (const { table_name, column_name, data_type } of columns) {
      const key = `${table_name}.${column_name}`;
      if (["double precision", "real", "numeric"].includes(data_type)) {
        expect(key in NOT_MONEY, `${key} is ${data_type} but not declared non-monetary`).toBe(true);
      }
      if (MONEY_NAME.test(column_name) && !(key in NOT_MONEY)) {
        expect(["integer", "bigint"], `${key} looks like money but is ${data_type}`).toContain(data_type);
        expect(column_name, key).toMatch(/(Cents|Bps)$/);
      }
    }
  });
});
