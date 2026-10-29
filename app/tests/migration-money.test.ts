import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientEscrow } from "@/lib/escrow/client";
import { storedCommissionView } from "@/lib/payouts/commissions";
import { databaseBefore, type MigrationDb } from "./helpers/migration-db";

/**
 * Issue #40, A4: the money migration converts existing data correctly.
 *
 * Builds a separate database at the migration before this one, writes data
 * in the old shape (whole shillings, Float rate and top-up, per-job
 * deposits, an approved and paid activation), applies the remaining
 * migrations with `prisma migrate deploy`, and checks every converted value.
 * The database is this test's own and is dropped at the end.
 */
const NEW_MIGRATION = "20261029100000_money_in_cents";

let scratch: MigrationDb;
let db: PrismaClient;

async function exec(sql: string): Promise<void> {
  await db.$executeRawUnsafe(sql);
}

/** An activation inserted as the old app would have, then walked through legal transitions. */
async function activation(id: string, assignment: string, job: string, path: string[]): Promise<void> {
  await exec(`INSERT INTO "Activation" (id, reference, "assignmentId", "agentId", "jobId", "submittedAt", "deviceId", "deviceOs", "appVersion",
    "ipRegion", "networkType", "gpsLat", "gpsLon", "customerMsisdnHash", "customerMsisdnMasked", "simRegisteredAt", "activationMethod", "updatedAt")
    VALUES ('${id}', 'LF-${id}', '${assignment}', 'agent1', '${job}', '2026-10-01 08:00', 'dev', 'android', '3.4.0',
    'region_a', 'cellular', -1.28, 36.83, 'hash-${id}', '07** *** 000', '2026-09-01', 'qr_scan', '2026-10-01 08:00')`);
  for (const state of path) await exec(`UPDATE "Activation" SET state = '${state}' WHERE id = '${id}'`);
}

const APPROVED = ["scored_t0", "held", "scored_t7", "approved"];
const REFUSED = ["scored_t0", "held", "scored_t7", "refused"];

beforeAll(async () => {
  scratch = await databaseBefore(NEW_MIGRATION, "money");
  db = scratch.db;

  await exec(`INSERT INTO "User" (id, email, name, "passwordHash", role) VALUES
    ('owner', 'owner@x.test', 'Owner', 'x', 'client'), ('agentuser', 'agent@x.test', 'Agent', 'x', 'agent'), ('admin', 'admin@x.test', 'Admin', 'x', 'admin')`);
  await exec(`INSERT INTO "ClientBusiness" (id, "userId", name) VALUES ('client1', 'owner', 'Client')`);
  await exec(`INSERT INTO "Agent" (id, "userId", "payoutMsisdn", "registeredAt", "homeLat", "homeLon", "homeAreaName")
    VALUES ('agent1', 'agentuser', '0712000000', '2025-01-01', -1.29, 36.82, 'CBD')`);
  // A: KSh 300 at 10%, 3 slots, fully funded in two deposits.
  // B: KSh 250 at 12.345%, 4 slots, only KSh 500 deposited (underfunded).
  // C: KSh 333 at 7%, 2 slots, KSh 2,000 deposited (overfunded).
  await exec(`INSERT INTO "Job" (id, "clientId", title, description, "areaName", "areaLat", "areaLon", "areaRadiusM", "payoutPerActivationKsh", "commissionRate", slots) VALUES
    ('jobA', 'client1', 'A', 'Job A', 'Area', -1.28, 36.83, 700, 300, 0.1, 3),
    ('jobB', 'client1', 'B', 'Job B', 'Area', -1.28, 36.83, 700, 250, 0.12345, 4),
    ('jobC', 'client1', 'C', 'Job C', 'Area', -1.28, 36.83, 700, 333, 0.07, 2)`);
  await exec(`INSERT INTO "EscrowDeposit" (id, "jobId", "amountKsh", "createdById") VALUES
    ('d1', 'jobA', 600, 'owner'), ('d2', 'jobA', 300, 'owner'), ('d3', 'jobB', 500, 'owner'), ('d4', 'jobC', 2000, 'owner')`);
  await exec(`INSERT INTO "Assignment" (id, "jobId", "agentId", "assignedById", "assignedAt", "acceptedAt") VALUES
    ('asA1', 'jobA', 'agent1', 'admin', '2026-10-01 06:00', '2026-10-01 07:00'),
    ('asA2', 'jobA', 'agent1', 'admin', '2026-10-01 06:00', '2026-10-01 07:00'),
    ('asA3', 'jobA', 'agent1', 'admin', '2026-10-01 06:00', NULL),
    ('asB1', 'jobB', 'agent1', 'admin', '2026-10-01 06:00', '2026-10-01 07:00')`);
  await exec(`INSERT INTO "EscrowHold" (id, "assignmentId", "amountKsh") VALUES ('hA1', 'asA1', 300), ('hA2', 'asA2', 300), ('hA3', 'asA3', 300), ('hB1', 'asB1', 250)`);
  await activation('actA1', 'asA1', 'jobA', APPROVED);
  await activation('actA2', 'asA2', 'jobA', REFUSED);
  await activation('actB1', 'asB1', 'jobB', APPROVED);
  await exec(`INSERT INTO "PayoutAuthorisation" (id, "activationId", "amountKsh", "payoutMsisdn", "authorisedAt", "authorisedById", provider) VALUES
    ('pA1', 'actA1', 300, '0712000000', '2026-10-09 10:00', 'admin', 'noop'),
    ('pB1', 'actB1', 250, '0712000000', '2026-10-09 11:00', NULL, 'noop')`);
  await exec(`INSERT INTO "CustomerActivityDay" (id, "activationId", day, "customerActive", "transactionCount", "topupAmountKsh", "usageMinutes", "supportContact", "complaintOrRefund", "simActive") VALUES
    ('day0', 'actA1', 0, true, 2, 12.5, 30, false, false, true), ('day1', 'actA1', 1, false, 0, 0, 0, false, false, true)`);

  scratch.migrate();
}, 180_000);

afterAll(async () => {
  await scratch?.drop();
});

describe("money migration on existing data (issue #40, A4)", () => {
  it("turns each job's flat payout into a commission structure that reproduces it exactly", async () => {
    const jobs = await db.job.findMany({ orderBy: { id: "asc" } });
    expect(jobs.map((j) => [j.id, j.submissionValueCents, j.commissionRateBps, j.flatCommissionCents])).toEqual([
      ["jobA", 300_000, 1000, 0],
      ["jobB", 202_430, 1235, 0],
      ["jobC", 475_715, 700, 0],
    ]);
    // floor(value x rate / 10000) is the old payout, in cents, for every job.
    for (const [job, payout] of [[jobs[0], 30_000], [jobs[1], 25_000], [jobs[2], 33_300]] as const) {
      expect((BigInt(job.submissionValueCents) * BigInt(job.commissionRateBps)) / 10_000n).toBe(BigInt(payout));
    }
  });

  it("locks the smaller of each job's liability and what was deposited for it", async () => {
    const locks = Object.fromEntries((await db.job.findMany()).map((j) => [j.id, j.escrowLockedCents]));
    expect(locks).toEqual({ jobA: 90_000, jobB: 50_000, jobC: 66_600 });
  });

  it("moves deposits to the client in cents, leaving the overfunding available and no balance negative", async () => {
    const deposits = await db.escrowDeposit.findMany({ orderBy: { id: "asc" } });
    expect(deposits.map((d) => [d.clientId, d.amountCents])).toEqual([["client1", 60_000], ["client1", 30_000], ["client1", 50_000], ["client1", 200_000]]);
    // KSh 3,400.00 deposited - (900 + 500 + 666) committed = KSh 1,334.00.
    expect(await clientEscrow(db, "client1")).toMatchObject({ depositedCents: 340_000, committedCents: 206_600, availableCents: 133_400 });
  });

  it("converts holds to cents and keeps their derived state", async () => {
    const holds = await db.escrowHoldState.findMany({ orderBy: { holdId: "asc" } });
    expect(holds.map((h) => [h.holdId, h.amountCents, h.state])).toEqual([
      ["hA1", 30_000, "released"],
      ["hA2", 30_000, "returned"],
      ["hA3", 30_000, "reserved"],
      ["hB1", 25_000, "released"],
    ]);
  });

  it("gives every approved activation one commission record and links its payout to it", async () => {
    const commissions = await db.commission.findMany({ orderBy: { activationId: "asc" }, include: { payout: true } });
    expect(commissions.map((c) => [c.activationId, c.amountCents, c.approvedById, c.payout?.amountCents])).toEqual([
      ["actA1", 30_000, "admin", 30_000],
      ["actB1", 25_000, null, 25_000],
    ]);
    expect(storedCommissionView(commissions[1]).derivation).toBe("KSh 2,024.30 × 12.35% = KSh 250.00 (rounded down to the cent)");
    expect(await db.commission.count({ where: { activationId: "actA2" } })).toBe(0);
  });

  it("stores the customer top-up as integer cents", async () => {
    const days = await db.customerActivityDay.findMany({ orderBy: { day: "asc" } });
    expect(days.map((d) => d.topupCents)).toEqual([1_250, 0]);
  });

  it("leaves no Float or Decimal money column in the migrated database", async () => {
    const fractional = await db.$queryRaw<{ name: string }[]>`
      SELECT table_name || '.' || column_name AS name FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type IN ('double precision', 'real', 'numeric')
        AND column_name ~* '(amount|ksh|cents|payout|commission|topup|escrow|deposit|value)'`;
    expect(fractional).toEqual([]);
  });
});
