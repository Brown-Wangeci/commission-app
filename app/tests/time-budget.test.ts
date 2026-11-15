import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/activations/transition";
import { useChain } from "@/lib/anchoring/chain";
import { runDueAnchoring } from "@/lib/anchoring/queue";
import { runDuePayments } from "@/lib/payments/worker";
import { approveActivation } from "@/lib/review/actions";
import { runDueScoringJobs } from "@/lib/scoring/runner";
import { anchorCallsReserveMs, anchorRoundMinimumMs, fits, NO_DEADLINE, paymentWorstCaseMs, requestDeadline, scoringRunWorstCaseMs } from "@/lib/time-budget";
import { addWeekOfActivity } from "./helpers/activity";
import { resetDatabase } from "./helpers/db";
import { FakeChain } from "./helpers/fake-chain";
import { createUser } from "./helpers/factories";
import { replyWith, startFakeScoring, type FakeScoring } from "./helpers/fake-scoring";
import { submitReady } from "./helpers/submission";

/**
 * Work done inside one request (the cron routes) must finish inside the
 * hosted function's limit: a unit of work is started only if its worst case
 * still fits, and what does not fit stays due for the next run. The
 * scheduler passes no deadline and is unaffected.
 */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const NAMES = ["SCORING_IMMEDIATE_ATTEMPTS", "SCORING_TIMEOUT_MS", "SCORING_IMMEDIATE_BACKOFF_MS", "MPESA_TIMEOUT_MS", "ANCHOR_RPC_TIMEOUT_MS", "ANCHOR_RECEIPT_TIMEOUT_MS", "CRON_TIME_BUDGET_SECONDS", "HOLD_WINDOW_SECONDS"];
const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

let scoring: FakeScoring;

beforeAll(async () => {
  scoring = await startFakeScoring(replyWith("auto_release", 0.05));
  process.env.SCORING_SERVICE_URL = scoring.url;
});
afterAll(() => scoring.close());
beforeEach(async () => {
  await resetDatabase();
  scoring.requests.length = 0;
  for (const name of NAMES) delete process.env[name];
  process.env.HOLD_WINDOW_SECONDS = "604800";
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  useChain();
});

describe("worst cases and the deadline", () => {
  it("a scoring run's worst case is every attempt timing out plus the doubling backoff", () => {
    // Defaults: 3 attempts of 15 s, backoff 0.5 s then 1 s.
    expect(scoringRunWorstCaseMs()).toBe(46_500);
    process.env.SCORING_IMMEDIATE_ATTEMPTS = "4";
    process.env.SCORING_TIMEOUT_MS = "10000";
    process.env.SCORING_IMMEDIATE_BACKOFF_MS = "100";
    expect(scoringRunWorstCaseMs()).toBe(4 * 10_000 + 100 + 200 + 400);
  });

  it("with the defaults, every unit fits the default 240 s budget, inside Vercel Hobby's 300 s", () => {
    const budgetMs = 240_000;
    expect(scoringRunWorstCaseMs()).toBeLessThan(budgetMs);
    expect(paymentWorstCaseMs()).toBe(60_000);
    expect(anchorRoundMinimumMs()).toBeLessThan(budgetMs);
    const started = Date.now();
    expect(requestDeadline(started)).toBe(started + budgetMs);
  });

  it("refuses a budget too short for one unit of work, instead of deferring for ever", () => {
    process.env.CRON_TIME_BUDGET_SECONDS = "30";
    expect(() => requestDeadline()).toThrow(/CRON_TIME_BUDGET_SECONDS \(30 s\) is shorter than the worst case for one scoring run \(46.5 s\)/);
  });

  it("refuses a budget that fits scoring and payments but could never start an anchoring round", () => {
    // Defaults: an anchoring round needs 2 x 4 x 20 s = 160 s to start.
    expect(anchorRoundMinimumMs()).toBe(160_000);
    process.env.CRON_TIME_BUDGET_SECONDS = "120";
    expect(() => requestDeadline()).toThrow(/worst case for an anchoring round \(160 s\)/);
  });

  it("no deadline always fits", () => {
    expect(fits(NO_DEADLINE, Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(fits(1_000, 500, 600)).toBe(false);
    expect(fits(1_000, 400, 600)).toBe(true);
  });
});

describe("a run with too little time left starts nothing and leaves it due", () => {
  it("scoring: the due T7 job is deferred, not called, and still pending", async () => {
    const { activationId } = await submitReady();
    await addWeekOfActivity(activationId);
    const later = new Date(Date.now() + WEEK_MS + 60_000);
    const summary = await runDueScoringJobs(later, 50, Date.now() + 1_000);
    expect(summary).toMatchObject({ scored: 0, deferred: 1 });
    expect(scoring.requests.filter((request) => request.mode === "t7")).toHaveLength(0);
    expect(await prisma.scoringJob.findFirstOrThrow({ where: { activationId, mode: "t7" } })).toMatchObject({ status: "pending", attempts: 0 });
    // The next run with time to spare takes it.
    expect(await runDueScoringJobs(later)).toMatchObject({ scored: 1, deferred: 0 });
  });

  it("payments: a queued payout is deferred, never sent, and still queued", async () => {
    scoring.setHandler(replyWith("reject", 0.9));
    const reviewer = await createUser("admin");
    const { activationId } = await submitReady();
    const at = new Date();
    await approveActivation({ activationId, reviewerId: reviewer.id, reason: "Evidence checks out", at });
    const summary = await runDuePayments(new Date(at.getTime() + 1_000), undefined, Date.now() + 1_000);
    expect(summary.sends).toBe(0);
    expect(summary.deferred).toBeGreaterThanOrEqual(1);
    expect(await prisma.disbursement.findUniqueOrThrow({ where: { activationId } })).toMatchObject({ status: "queued", sendCount: 0 });
  });

  it("anchoring: no round starts, and the chain is not called", async () => {
    const chain = new FakeChain();
    useChain(chain);
    await recordAuditEvent(prisma, { kind: "test", detail: "one event" });
    const summary = await runDueAnchoring(new Date(), Date.now() + 1_000);
    expect(summary).toMatchObject({ created: 0, confirmed: 0, waiting: expect.stringMatching(/Deferred/) });
    expect(chain.calls).toHaveLength(0);
  });

  it("anchoring: the receipt wait is cut so the calls after it still fit", async () => {
    const chain = new FakeChain();
    const waits: number[] = [];
    const original = chain.waitForReceipt.bind(chain);
    chain.waitForReceipt = async (txHash: string, timeoutMs?: number) => {
      waits.push(timeoutMs ?? -1);
      return original(txHash);
    };
    useChain(chain);
    await recordAuditEvent(prisma, { kind: "test", detail: "one event" });
    const reserve = anchorCallsReserveMs();
    const deadline = Date.now() + 2 * reserve + 5_000;
    expect(await runDueAnchoring(new Date(), deadline)).toMatchObject({ created: 1, confirmed: 1 });
    expect(waits).toHaveLength(1);
    // About reserve + 5 s were left after the round started; the wait keeps a reserve back.
    expect(waits[0]).toBeLessThanOrEqual(reserve + 5_000);
    expect(waits[0]).toBeLessThan(120_000);
  });

  it("anchoring with no deadline waits the full ANCHOR_RECEIPT_TIMEOUT_MS, as before", async () => {
    const chain = new FakeChain();
    const waits: number[] = [];
    const original = chain.waitForReceipt.bind(chain);
    chain.waitForReceipt = async (txHash: string, timeoutMs?: number) => {
      waits.push(timeoutMs ?? -1);
      return original(txHash);
    };
    useChain(chain);
    await recordAuditEvent(prisma, { kind: "test", detail: "one event" });
    await runDueAnchoring(new Date());
    expect(waits).toEqual([120_000]);
  });
});
