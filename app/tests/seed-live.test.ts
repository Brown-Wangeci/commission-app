import { execFileSync } from "node:child_process";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { resetDatabase } from "./helpers/db";

/**
 * Issue #16: the seed runs on an empty database and can be rerun safely.
 * The seed scores every activation with the real scoring service, so this
 * runs only when the service at LIVE_SCORING_URL is up.
 */
const liveUrl = process.env.LIVE_SCORING_URL ?? "http://127.0.0.1:8000";
const appDir = path.resolve(__dirname, "..");

async function serviceIsUp(): Promise<boolean> {
  try {
    const response = await fetch(new URL("/health", liveUrl), { signal: AbortSignal.timeout(2000) });
    return response.ok && ((await response.json()) as { loaded?: boolean }).loaded === true;
  } catch {
    return false;
  }
}

function runSeed(): string {
  return execFileSync(process.execPath, [path.join(appDir, "node_modules", "tsx", "dist", "cli.mjs"), "prisma/seed.ts"], {
    cwd: appDir,
    env: { ...process.env, SCORING_SERVICE_URL: liveUrl },
    encoding: "utf8",
    timeout: 240_000,
  });
}

async function stateCounts(): Promise<Record<string, number>> {
  const groups = await prisma.activation.groupBy({ by: ["state"], _count: { _all: true } });
  return Object.fromEntries(groups.map((g) => [g.state, g._count._all]));
}

const up = await serviceIsUp();

beforeAll(resetDatabase);

describe.runIf(up)("seed data (issue #16)", () => {
  it("seeds an empty database with every resting state, three roles, and payouts", async () => {
    const output = runSeed();
    const counts = await stateCounts();
    for (const state of ["submitted", "held", "in_review", "awaiting_evidence", "approved", "refused", "disputed", "withdrawn"]) {
      expect(counts[state] ?? 0, state).toBeGreaterThan(0);
    }
    const roles = await prisma.user.groupBy({ by: ["role"], _count: { _all: true } });
    expect(roles.map((r) => r.role).sort()).toEqual(["admin", "agent", "client"]);
    expect(await prisma.payoutAuthorisation.count()).toBe(counts.approved);
    const transitIn = await prisma.auditEvent.count({ where: { toState: { in: ["scored_t0", "scored_t7"] } } });
    expect(transitIn).toBeGreaterThan(0);
    expect(output).toContain("Every named case landed where intended.");
  }, 300_000);

  it("can be rerun and produces the same data", async () => {
    const before = await stateCounts();
    runSeed();
    expect(await stateCounts()).toEqual(before);
    expect(await prisma.user.count({ where: { email: { endsWith: "@ledgerfield.test" } } })).toBe(await prisma.user.count());
  }, 300_000);

  it("refuses to clear a database holding accounts it did not create", async () => {
    await prisma.user.create({ data: { email: "someone@real.example", name: "Real Person", passwordHash: "x", role: "client" } });
    expect(() => runSeed()).toThrow(/Refusing to clear it/);
    expect(await prisma.user.count({ where: { email: "someone@real.example" } })).toBe(1);
  }, 300_000);
});
