import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import PayoutsPage from "@/app/admin/payouts/page";
import { prisma } from "@/lib/db";
import { checkDisbursement, expireStaleSends, sendDisbursement } from "@/lib/payments/disbursement";
import { runDuePayments } from "@/lib/payments/worker";
import { usePayoutAuthoriser } from "@/lib/payouts/boundary";
import { DarajaPayoutAuthoriser } from "@/lib/payouts/daraja";
import { approveActivation } from "@/lib/review/actions";
import { runDueScoringJobs } from "@/lib/scoring/runner";
import { addWeekOfActivity } from "./helpers/activity";
import { b2cFailure, b2cSuccess, deliver, deliverTo, statusResult } from "./helpers/daraja-payloads";
import { resetDatabase } from "./helpers/db";
import { createUser } from "./helpers/factories";
import { PATHS, startFakeDaraja, type FakeDaraja } from "./helpers/fake-daraja";
import { replyWith, startFakeScoring, type FakeScoring } from "./helpers/fake-scoring";
import { submitReady } from "./helpers/submission";

const COMMISSION = 30_000;
const t0 = new Date("2026-11-07T09:00:00.000Z");
const after = (ms: number) => new Date(t0.getTime() + ms);

let daraja: FakeDaraja;
let scoring: FakeScoring;

beforeAll(async () => {
  daraja = await startFakeDaraja();
  scoring = await startFakeScoring();
  process.env.MPESA_BASE_URL = daraja.url;
  process.env.SCORING_SERVICE_URL = scoring.url;
});
afterAll(async () => {
  await daraja.close();
  await scoring.close();
});
beforeEach(async () => {
  await resetDatabase();
  daraja.reset();
  scoring.setHandler(replyWith("reject", 0.9));
  usePayoutAuthoriser(new DarajaPayoutAuthoriser());
  process.env.MPESA_TIMEOUT_MS = "1000";
});

/** An activation in review (a T0 reject escalates straight to a reviewer). */
async function inReview(): Promise<{ activationId: string; reviewerId: string }> {
  const reviewer = await createUser("admin");
  const { activationId } = await submitReady();
  return { activationId, reviewerId: reviewer.id };
}

/** The first callback about a payout. The funding behind each job delivers its own. */
function payoutCallback() {
  return prisma.paymentCallback.findFirstOrThrow({ where: { kind: { not: "stk" } } });
}

function row(activationId: string) {
  return prisma.disbursement.findUniqueOrThrow({ where: { activationId } });
}

/** Approved at t0, so the instruction is queued and due at t0. */
async function approved() {
  const { activationId, reviewerId } = await inReview();
  await approveActivation({ activationId, reviewerId, reason: "Evidence checks out", at: t0 });
  return { activationId, reviewerId, disbursement: await row(activationId) };
}

/** Approved and accepted by Daraja. */
async function sent() {
  const state = await approved();
  await sendDisbursement(state.disbursement.id, t0);
  return { ...state, disbursement: await row(state.activationId) };
}

function success(d: { reference: string; conversationId: string | null }, amount: number | string = 300, receipt = "SG632NMUAB") {
  return b2cSuccess({ reference: d.reference, conversationId: d.conversationId ?? "AG_FAKE", amount, receipt });
}

function scriptB2c(reply: Parameters<FakeDaraja["setHandler"]>[0] extends (c: never) => infer R ? R : never) {
  daraja.setHandler((call) => (call.path === PATHS.b2c ? reply : undefined));
}

describe("approval queues a B2C instruction (B1, B2)", () => {
  it("records the instruction with the approval, and calls nothing during approval", async () => {
    const { activationId, disbursement } = await approved();
    expect(disbursement).toMatchObject({ status: "queued", amountCents: COMMISSION, sendCount: 0, payoutMsisdn: "0712000000" });
    const authorisation = await prisma.payoutAuthorisation.findUniqueOrThrow({ where: { activationId } });
    expect(authorisation).toMatchObject({ provider: "daraja", providerRef: disbursement.reference });
    expect(daraja.calls).toHaveLength(0);
  });

  it("pays the stored commission, converted only at the boundary", async () => {
    const { activationId, disbursement } = await approved();
    const commission = await prisma.commission.findUniqueOrThrow({ where: { activationId } });
    await sendDisbursement(disbursement.id, t0);
    const [payment] = daraja.callsTo(PATHS.b2c);
    expect(commission.amountCents).toBe(COMMISSION);
    expect(payment.body).toMatchObject({
      OriginatorConversationID: disbursement.reference, InitiatorName: "test-initiator", SecurityCredential: "test-security-credential",
      CommandID: "BusinessPayment", Amount: "300", PartyA: "600000", PartyB: "254712000000",
    });
    expect(String(payment.body.Remarks).length).toBeGreaterThanOrEqual(2);
    expect(String(payment.body.ResultURL)).toMatch(/^https:\/\/callbacks\.test\/api\/payments\/callback\/b2c-result\/[0-9a-f]{32}\/[0-9a-f]{64}$/);
    expect(String(payment.body.QueueTimeOutURL)).toMatch(/\/callback\/b2c-timeout\//);
    expect(await row(activationId)).toMatchObject({ status: "sent", conversationId: expect.stringMatching(/^AG_FAKE/) });
  });

  it("queues on the automatic path too, at hold-close", async () => {
    scoring.setHandler(replyWith("auto_release", 0.05));
    const { activationId } = await submitReady();
    await addWeekOfActivity(activationId);
    const job = await prisma.scoringJob.findFirstOrThrow({ where: { activationId, mode: "t7" } });
    await runDueScoringJobs(new Date(job.dueAt.getTime() + 1000));
    expect((await prisma.activation.findUniqueOrThrow({ where: { id: activationId } })).state).toBe("approved");
    expect((await row(activationId)).status).toBe("queued");
  });

  it("leaves no instruction behind when the approval rolls back", async () => {
    const { activationId, reviewerId } = await inReview();
    usePayoutAuthoriser({ provider: "broken", authorise: async () => { throw new Error("provider down"); } });
    await expect(approveActivation({ activationId, reviewerId, reason: "Evidence checks out" })).rejects.toThrow("provider down");
    expect(await prisma.disbursement.count()).toBe(0);
  });

  it("marks the agent paid only on a success result, and tells them", async () => {
    const { activationId, disbursement } = await sent();
    const agent = await prisma.activation.findUniqueOrThrow({ where: { id: activationId }, select: { agent: { select: { userId: true } } } });
    expect(await prisma.notification.count({ where: { userId: agent.agent.userId, kind: "payout_paid" } })).toBe(0);
    await deliver("b2c-result", disbursement.reference, success(disbursement));
    expect(await row(activationId)).toMatchObject({ status: "paid", receipt: "SG632NMUAB", resultCode: "0" });
    expect(await prisma.notification.count({ where: { userId: agent.agent.userId, kind: "payout_paid" } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { activationId, kind: "payout_paid" } })).toBe(1);
  });
});

describe("at most one disbursement (C2, NFR-04)", () => {
  it("replaying the same callback twenty times pays once", async () => {
    const { activationId, disbursement } = await sent();
    const body = success(disbursement);
    for (let i = 0; i < 20; i += 1) expect((await deliver("b2c-result", disbursement.reference, body)).status).toBe(200);
    expect((await row(activationId)).status).toBe("paid");
    expect(await payoutCallback()).toMatchObject({ deliveries: 20, outcome: "applied" });
    expect(await prisma.notification.count({ where: { kind: "payout_paid" } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { kind: "payout_paid" } })).toBe(1);
    await runDuePayments(after(10_000_000));
    expect(daraja.callsTo(PATHS.b2c)).toHaveLength(1);
  });

  it("replaying it concurrently pays once", async () => {
    const { activationId, disbursement } = await sent();
    const body = success(disbursement);
    const responses = await Promise.all(Array.from({ length: 12 }, () => deliver("b2c-result", disbursement.reference, body)));
    expect(responses.map((r) => r.status)).toEqual(Array(12).fill(200));
    expect((await row(activationId)).status).toBe("paid");
    expect(await prisma.notification.count({ where: { kind: "payout_paid" } })).toBe(1);
    expect((await payoutCallback()).deliveries).toBe(12);
  });

  it("concurrent approvals of one submission produce one instruction and one payment", async () => {
    const { activationId, reviewerId } = await inReview();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => approveActivation({ activationId, reviewerId, reason: "Evidence checks out", at: t0 })),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.disbursement.count({ where: { activationId } })).toBe(1);
    expect(await prisma.payoutAuthorisation.count({ where: { activationId } })).toBe(1);
    expect(await prisma.commission.count({ where: { activationId } })).toBe(1);
    await Promise.all([runDuePayments(t0), runDuePayments(t0), runDuePayments(t0)]);
    expect(daraja.callsTo(PATHS.b2c)).toHaveLength(1);
  });

  it("two workers racing send once", async () => {
    const { disbursement } = await approved();
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => sendDisbursement(disbursement.id, t0)));
    expect(outcomes.filter((outcome) => outcome === "sent")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "not_claimed")).toHaveLength(5);
    expect(daraja.callsTo(PATHS.b2c)).toHaveLength(1);
  });

  it("the database refuses a second instruction for the same approval", async () => {
    const { disbursement } = await approved();
    const { id: _id, createdAt: _created, updatedAt: _updated, ...copy } = disbursement;
    await expect(prisma.disbursement.create({ data: { ...copy, reference: "c".repeat(32) } })).rejects.toThrow(/Unique constraint/);
  });

  it("the database refuses an instruction that differs from its authorisation", async () => {
    const { activationId, disbursement } = await approved();
    await prisma.$executeRaw`ALTER TABLE "Disbursement" DISABLE TRIGGER "Disbursement_no_delete"`;
    await prisma.disbursement.delete({ where: { activationId } });
    await prisma.$executeRaw`ALTER TABLE "Disbursement" ENABLE TRIGGER "Disbursement_no_delete"`;
    const { id: _id, createdAt: _created, updatedAt: _updated, ...copy } = disbursement;
    await expect(prisma.disbursement.create({ data: { ...copy, amountCents: COMMISSION + 100 } })).rejects.toThrow(/must pay exactly its authorisation/);
    await expect(prisma.disbursement.create({ data: { ...copy, payoutMsisdn: "0700000000" } })).rejects.toThrow(/must pay exactly its authorisation/);
    await expect(prisma.disbursement.create({ data: { ...copy, status: "sent" } })).rejects.toThrow(/starts unsent/);
  });

  it("the database stops anything Daraja may hold from becoming sendable again", async () => {
    const { disbursement: accepted } = await sent();
    const set = (status: "queued" | "sending", id = accepted.id) => prisma.disbursement.update({ where: { id }, data: { status } });
    await expect(set("queued")).rejects.toThrow(/cannot move from sent to queued/);
    await expect(set("sending")).rejects.toThrow(/cannot move from sent to sending/);
    await prisma.disbursement.update({ where: { id: accepted.id }, data: { status: "unconfirmed" } });
    await expect(set("queued")).rejects.toThrow(/cannot move from unconfirmed to queued/);
    await deliver("b2c-result", accepted.reference, success(accepted));
    await expect(set("queued")).rejects.toThrow(/cannot move from paid to queued/);
    await expect(prisma.disbursement.update({ where: { id: accepted.id }, data: { status: "failed" } })).rejects.toThrow(/cannot move from paid to failed/);
  });

  it("the database refuses a change to the instruction, a paid row with no receipt, and any delete", async () => {
    const { disbursement } = await approved();
    const { id } = disbursement;
    await expect(prisma.disbursement.update({ where: { id }, data: { amountCents: 1 } })).rejects.toThrow(/instruction cannot change/);
    await expect(prisma.disbursement.update({ where: { id }, data: { payoutMsisdn: "0700000000" } })).rejects.toThrow(/instruction cannot change/);
    await expect(prisma.disbursement.update({ where: { id }, data: { reference: "d".repeat(32) } })).rejects.toThrow(/instruction cannot change/);
    await expect(prisma.disbursement.update({ where: { id }, data: { status: "paid" } })).rejects.toThrow(/needs its M-Pesa receipt/);
    await expect(prisma.disbursement.delete({ where: { id } })).rejects.toThrow();
  });

  it("one receipt cannot settle two payouts", async () => {
    const first = await sent();
    const second = await sent();
    await deliver("b2c-result", first.disbursement.reference, success(first.disbursement, 300, "SAMERECEIPT"));
    await deliver("b2c-result", second.disbursement.reference, success(second.disbursement, 300, "SAMERECEIPT"));
    expect((await row(second.activationId)).status).toBe("sent");
    expect(await prisma.paymentCallback.count({ where: { outcome: "conflict" } })).toBe(1);
  });
});

describe("callbacks out of order, duplicated or unknown (C3)", () => {
  it("a result that beats the acceptance response stays settled, and the id is still kept", async () => {
    const { activationId, disbursement } = await approved();
    let delivered: Promise<Response> | null = null;
    daraja.setHandler((call) => {
      if (call.path !== PATHS.b2c) return undefined;
      delivered = deliver("b2c-result", disbursement.reference, b2cSuccess({ reference: disbursement.reference, conversationId: "AG_RACE", amount: 300 }));
      return { status: 200, delayMs: 150, body: { ConversationID: "AG_RACE", OriginatorConversationID: disbursement.reference, ResponseCode: "0" } };
    });
    await sendDisbursement(disbursement.id, t0);
    await delivered;
    expect(await row(activationId)).toMatchObject({ status: "paid", conversationId: "AG_RACE", receipt: "SG632NMUAB" });
  });

  it("a success for an instruction still queued settles it, and it is never sent", async () => {
    const { activationId, disbursement } = await approved();
    await deliver("b2c-result", disbursement.reference, success({ reference: disbursement.reference, conversationId: "AG_EARLY" }));
    expect((await row(activationId)).status).toBe("paid");
    await runDuePayments(after(1000));
    expect(daraja.callsTo(PATHS.b2c)).toHaveLength(0);
  });

  it("a failure after a success leaves it paid and raises it", async () => {
    const { activationId, disbursement } = await sent();
    await deliver("b2c-result", disbursement.reference, success(disbursement));
    await deliver("b2c-result", disbursement.reference, b2cFailure({ reference: disbursement.reference, conversationId: disbursement.conversationId! }));
    expect((await row(activationId)).status).toBe("paid");
    expect(await prisma.paymentCallback.count({ where: { outcome: "conflict" } })).toBe(1);
    expect(await prisma.notification.count({ where: { kind: "payment_attention" } })).toBeGreaterThan(0);
  });

  it("a success after M-Pesa reported failure does not mark it paid, and raises it", async () => {
    const { activationId, disbursement } = await sent();
    await deliver("b2c-result", disbursement.reference, b2cFailure({ reference: disbursement.reference, conversationId: disbursement.conversationId! }));
    await deliver("b2c-result", disbursement.reference, success(disbursement));
    expect((await row(activationId)).status).toBe("failed");
    expect(await prisma.paymentCallback.count({ where: { outcome: "conflict" } })).toBe(1);
  });

  it("a second, different receipt for a paid payout changes nothing", async () => {
    const { activationId, disbursement } = await sent();
    await deliver("b2c-result", disbursement.reference, success(disbursement, 300, "FIRSTRECEIPT"));
    await deliver("b2c-result", disbursement.reference, success(disbursement, 300, "SECONDRECEIPT"));
    expect((await row(activationId)).receipt).toBe("FIRSTRECEIPT");
    expect(await prisma.paymentCallback.count({ where: { outcome: "conflict" } })).toBe(1);
  });

  it("a queue timeout after payment changes nothing", async () => {
    const { activationId, disbursement } = await sent();
    await deliver("b2c-result", disbursement.reference, success(disbursement));
    await deliver("b2c-timeout", disbursement.reference, { Result: { ResultCode: 1, ResultDesc: "timeout" } });
    expect((await row(activationId)).status).toBe("paid");
  });

  it("a callback naming a different conversation changes nothing", async () => {
    const { activationId, disbursement } = await sent();
    await deliver("b2c-result", disbursement.reference, success({ reference: disbursement.reference, conversationId: "AG_SOMEONE_ELSE" }));
    expect((await row(activationId)).status).toBe("sent");
  });

  it("a success reporting the wrong amount is not marked paid", async () => {
    const { activationId, disbursement } = await sent();
    await deliver("b2c-result", disbursement.reference, success(disbursement, 299));
    expect((await row(activationId)).status).toBe("sent");
    const callback = await payoutCallback();
    expect(callback).toMatchObject({ outcome: "conflict" });
    expect(callback.note).toMatch(/KSh 299.00 against KSh 300.00/);
  });

  it("an unknown reference is recorded, acknowledged, and changes nothing", async () => {
    const { activationId, disbursement } = await sent();
    const response = await deliver("b2c-result", "e".repeat(32), success({ reference: "e".repeat(32), conversationId: "AG_X" }));
    expect(response.status).toBe(200);
    expect(await payoutCallback()).toMatchObject({ outcome: "unknown_reference" });
    expect((await row(activationId)).status).toBe(disbursement.status);
  });

  it("a body it cannot read is recorded and changes nothing", async () => {
    const { activationId, disbursement } = await sent();
    const response = await deliver("b2c-result", disbursement.reference, { surprising: true });
    expect(response.status).toBe(200);
    expect(await payoutCallback()).toMatchObject({ outcome: "ignored" });
    expect((await row(activationId)).status).toBe("sent");
  });

  it("stores no name or number from a result", async () => {
    const { disbursement } = await sent();
    await deliver("b2c-result", disbursement.reference, success(disbursement));
    const stored = JSON.stringify(await payoutCallback());
    expect(stored).not.toContain("SONGOK");
    expect(stored).not.toContain("254705912645");
  });
});

describe("origin verification before acting (C1, IR-02)", () => {
  async function signed() {
    const { activationId, disbursement } = await sent();
    return { activationId, disbursement, body: JSON.stringify(success(disbursement)) };
  }

  it("refuses a wrong signature, and records and changes nothing", async () => {
    const { activationId, disbursement, body } = await signed();
    const response = await deliverTo({ kind: "b2c-result", reference: disbursement.reference, signature: "0".repeat(64) }, body);
    expect(response.status).toBe(401);
    expect((await response.json()).error.message).toBe("Not accepted.");
    expect(await prisma.paymentCallback.count({ where: { kind: { not: "stk" } } })).toBe(0);
    expect((await row(activationId)).status).toBe("sent");
  });

  it("refuses an unknown kind, and a signature made for another kind", async () => {
    const { disbursement, body } = await signed();
    const { callbackUrl } = await import("@/lib/payments/callback-url");
    const forTimeout = callbackUrl("b2c-timeout", disbursement.reference).split("/").at(-1) as string;
    expect((await deliverTo({ kind: "b2c-result", reference: disbursement.reference, signature: forTimeout }, body)).status).toBe(401);
    expect((await deliverTo({ kind: "anything", reference: disbursement.reference, signature: forTimeout }, body)).status).toBe(401);
  });

  it("refuses a source outside the list when one is configured", async () => {
    const { activationId, disbursement, body } = await signed();
    process.env.MPESA_CALLBACK_ALLOWED_IPS = "196.201.214.0/24";
    try {
      expect((await deliver("b2c-result", disbursement.reference, body, { "x-forwarded-for": "6.6.6.6" })).status).toBe(401);
      expect((await row(activationId)).status).toBe("sent");
      expect((await deliver("b2c-result", disbursement.reference, body, { "x-forwarded-for": "196.201.214.200" })).status).toBe(200);
      expect((await row(activationId)).status).toBe("paid");
    } finally {
      delete process.env.MPESA_CALLBACK_ALLOWED_IPS;
    }
  });

  it("answers invalid JSON and an oversized body with a refusal, not a crash", async () => {
    const { activationId, disbursement } = await signed();
    expect((await deliver("b2c-result", disbursement.reference, "not json")).status).toBe(400);
    expect((await deliver("b2c-result", disbursement.reference, "x".repeat(70_000))).status).toBe(413);
    expect((await row(activationId)).status).toBe("sent");
  });

  it("logs no part of a refused URL", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { disbursement, body } = await signed();
    await deliverTo({ kind: "b2c-result", reference: disbursement.reference, signature: "feedface".repeat(8) }, body);
    const logged = JSON.stringify(warn.mock.calls);
    warn.mockRestore();
    expect(logged).toContain("refused a callback");
    expect(logged).not.toContain("feedface");
    expect(logged).not.toContain(disbursement.reference);
  });
});

describe("when Daraja is unavailable or errors (D1, IR-03)", () => {
  const busy = { status: 500, body: { errorCode: "500.003.02", errorMessage: "System is busy. Please try again in few minutes." } };

  it("retains the instruction and retries with doubling delays, always with the same id", async () => {
    scriptB2c(busy);
    const { activationId, disbursement } = await approved();
    await sendDisbursement(disbursement.id, t0);
    const first = await row(activationId);
    expect(first).toMatchObject({ status: "queued", sendCount: 1 });
    expect(first.lastError).toMatch(/busy/i);
    expect(first.nextAttemptAt.getTime() - t0.getTime()).toBe(60_000);
    await sendDisbursement(disbursement.id, first.nextAttemptAt);
    const second = await row(activationId);
    expect(second.nextAttemptAt.getTime() - first.nextAttemptAt.getTime()).toBe(120_000);
    await sendDisbursement(disbursement.id, second.nextAttemptAt);
    const ids = daraja.callsTo(PATHS.b2c).map((call) => call.body.OriginatorConversationID);
    expect(new Set(ids)).toEqual(new Set([disbursement.reference]));
    expect(ids).toHaveLength(3);
  });

  it("does not send before the retry is due", async () => {
    scriptB2c(busy);
    const { activationId, disbursement } = await approved();
    await sendDisbursement(disbursement.id, t0);
    expect(await sendDisbursement(disbursement.id, after(59_000))).toBe("not_claimed");
    expect((await row(activationId)).sendCount).toBe(1);
  });

  it("recovers when Daraja comes back", async () => {
    scriptB2c(busy);
    const { activationId, disbursement } = await approved();
    await sendDisbursement(disbursement.id, t0);
    daraja.setHandler(() => undefined);
    await runDuePayments(after(61_000));
    expect((await row(activationId)).status).toBe("sent");
    expect(daraja.callsTo(PATHS.b2c)).toHaveLength(2);
  });

  it("retries when Daraja cannot be reached at all", async () => {
    const { activationId, disbursement } = await approved();
    process.env.MPESA_BASE_URL = "http://127.0.0.1:9";
    try {
      await sendDisbursement(disbursement.id, t0);
    } finally {
      process.env.MPESA_BASE_URL = daraja.url;
    }
    const stored = await row(activationId);
    expect(stored).toMatchObject({ status: "queued", sendCount: 1 });
    expect(stored.lastError).toMatch(/could not|fetch failed|ECONNREFUSED/i);
  });

  it("stops at the limit, keeps the reason, and tells every administrator", async () => {
    scriptB2c({ status: 503, body: "unavailable" });
    const { activationId, disbursement, reviewerId } = await approved();
    let now = t0;
    for (let i = 0; i < 6; i += 1) {
      await sendDisbursement(disbursement.id, now);
      now = (await row(activationId)).nextAttemptAt;
    }
    const stored = await row(activationId);
    expect(stored).toMatchObject({ status: "failed", sendCount: 6 });
    expect(stored.failureReason).toMatch(/after 6 tries: Daraja is unavailable \(HTTP 503\)/);
    expect(stored.escalatedAt).not.toBeNull();
    expect(await prisma.notification.count({ where: { userId: reviewerId, kind: "payment_attention" } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { activationId, kind: "payout_failed" } })).toBe(1);
    await runDuePayments(after(100_000_000));
    expect(daraja.callsTo(PATHS.b2c)).toHaveLength(6);
  });

  it("fails at once when Daraja refuses for good, and keeps its reason", async () => {
    scriptB2c({ status: 400, body: { errorCode: "400.002.02", errorMessage: "Bad Request - Invalid PartyB" } });
    const { activationId, disbursement } = await approved();
    await sendDisbursement(disbursement.id, t0);
    expect(await row(activationId)).toMatchObject({ status: "failed", sendCount: 1, failureReason: "Bad Request - Invalid PartyB", resultCode: "400.002.02" });
    await runDuePayments(after(100_000_000));
    expect(daraja.callsTo(PATHS.b2c)).toHaveLength(1);
  });

  it("records a failure result with Daraja's reason, and does not retry it", async () => {
    const { activationId, disbursement } = await sent();
    await deliver("b2c-result", disbursement.reference, b2cFailure({ reference: disbursement.reference, conversationId: disbursement.conversationId!, resultCode: 1, resultDesc: "The balance is insufficient for the transaction." }));
    expect(await row(activationId)).toMatchObject({ status: "failed", resultCode: "1", failureReason: "The balance is insufficient for the transaction." });
    await runDuePayments(after(100_000_000));
    expect(daraja.callsTo(PATHS.b2c)).toHaveLength(1);
  });

  it("waits, spending no retries, while credentials are missing", async () => {
    const { activationId } = await approved();
    const saved = process.env.MPESA_CALLBACK_BASE_URL;
    delete process.env.MPESA_CALLBACK_BASE_URL;
    const summary = await runDuePayments(t0);
    process.env.MPESA_CALLBACK_BASE_URL = saved;
    expect(summary.skipped).toBe(true);
    expect(await row(activationId)).toMatchObject({ status: "queued", sendCount: 0 });
    expect(daraja.calls).toHaveLength(0);
  });
});

describe("an uncertain send is never sent again (D1, NFR-04)", () => {
  const resultWait = 900_000;

  async function timedOut() {
    process.env.MPESA_TIMEOUT_MS = "100";
    scriptB2c({ status: 200, body: {}, delayMs: 500 });
    const state = await approved();
    await sendDisbursement(state.disbursement.id, t0);
    process.env.MPESA_TIMEOUT_MS = "1000";
    daraja.setHandler(() => undefined);
    return state;
  }

  it("a timeout after sending becomes unconfirmed, and is checked, not resent", async () => {
    const { activationId } = await timedOut();
    const stored = await row(activationId);
    expect(stored.status).toBe("unconfirmed");
    expect(stored.lastError).toMatch(/may or may not/);
    await runDuePayments(after(resultWait + 1));
    expect(daraja.callsTo(PATHS.b2c)).toHaveLength(1);
    expect(daraja.callsTo(PATHS.status)).toHaveLength(1);
  });

  it("a gateway error with no Daraja answer is unconfirmed too", async () => {
    scriptB2c({ status: 504, body: "<html>Gateway Timeout</html>" });
    const { activationId, disbursement } = await approved();
    await sendDisbursement(disbursement.id, t0);
    expect((await row(activationId)).status).toBe("unconfirmed");
  });

  it("a dropped connection is unconfirmed too", async () => {
    scriptB2c({ status: 200, body: {}, destroy: true });
    const { activationId, disbursement } = await approved();
    await sendDisbursement(disbursement.id, t0);
    expect((await row(activationId)).status).toBe("unconfirmed");
  });

  it("Daraja's duplicate refusal means it already holds the instruction", async () => {
    const { activationId, disbursement } = await approved();
    scriptB2c({ status: 500, body: { requestId: "x", errorCode: "500.002.1001", errorMessage: "Duplicate OriginatorConversationID." } });
    await sendDisbursement(disbursement.id, t0);
    const stored = await row(activationId);
    expect(stored.status).toBe("unconfirmed");
    expect(stored.lastError).toMatch(/already holds/);
  });

  it("a worker that stopped mid-send leaves it unconfirmed, never queued", async () => {
    const { activationId, disbursement } = await approved();
    await prisma.disbursement.update({ where: { id: disbursement.id }, data: { status: "sending", sendCount: 1, lockedUntil: t0 } });
    expect(await expireStaleSends(after(1000))).toBe(1);
    expect((await row(activationId)).status).toBe("unconfirmed");
    await runDuePayments(after(2000));
    expect(daraja.callsTo(PATHS.b2c)).toHaveLength(0);
  });

  it("a queue timeout callback makes a sent instruction unconfirmed, not failed", async () => {
    const { activationId, disbursement } = await sent();
    await deliver("b2c-timeout", disbursement.reference, { Result: { ResultCode: 1, ResultDesc: "The service request timed out." } });
    const stored = await row(activationId);
    expect(stored.status).toBe("unconfirmed");
    expect(stored.lastError).toMatch(/may still complete/);
  });

  it("a result overdue from a sent instruction triggers a status check", async () => {
    const { activationId, disbursement } = await sent();
    await checkDisbursement(disbursement.id, after(resultWait + 1));
    const [query] = daraja.callsTo(PATHS.status);
    expect(query.body).toMatchObject({ CommandID: "TransactionStatusQuery", OriginalConversationID: disbursement.reference, IdentifierType: "4", PartyA: "600000", Initiator: "test-initiator" });
    expect(String(query.body.ResultURL)).toMatch(/\/callback\/status-result\//);
    expect((await row(activationId)).status).toBe("unconfirmed");
  });

  it("the status result settles it as paid when M-Pesa says Completed", async () => {
    const { activationId, disbursement } = await timedOut();
    await deliver("status-result", disbursement.reference, statusResult({ reference: disbursement.reference, status: "Completed" }));
    expect(await row(activationId)).toMatchObject({ status: "paid", receipt: "MBN31H462N" });
  });

  it("the status result settles it as failed when M-Pesa says Declined", async () => {
    const { activationId, disbursement } = await timedOut();
    await deliver("status-result", disbursement.reference, statusResult({ reference: disbursement.reference, status: "Declined" }));
    expect(await row(activationId)).toMatchObject({ status: "failed", failureReason: "M-Pesa reports this payout as Declined." });
  });

  it("an inconclusive status result changes nothing", async () => {
    const { activationId, disbursement } = await timedOut();
    await deliver("status-result", disbursement.reference, statusResult({ reference: disbursement.reference, status: "Initiated" }));
    await deliver("status-result", disbursement.reference, statusResult({ reference: disbursement.reference, status: "Completed", resultCode: 1, resultDesc: "Not found" }));
    await deliver("status-timeout", disbursement.reference, { Result: { ResultCode: 1 } });
    expect((await row(activationId)).status).toBe("unconfirmed");
  });

  it("a status result about a different payout changes nothing", async () => {
    const { activationId, disbursement } = await timedOut();
    await deliver("status-result", disbursement.reference, statusResult({ reference: "f".repeat(32), status: "Completed" }));
    expect((await row(activationId)).status).toBe("unconfirmed");
    expect(await prisma.paymentCallback.count({ where: { outcome: "conflict" } })).toBe(1);
  });

  it("after the check limit it is raised to an administrator, and still not resent", async () => {
    const { activationId, disbursement, reviewerId } = await timedOut();
    let now = after(resultWait + 1);
    for (let i = 0; i < 4; i += 1) {
      await checkDisbursement(disbursement.id, now);
      now = new Date((await row(activationId)).nextAttemptAt.getTime() + 1);
    }
    const stored = await row(activationId);
    expect(stored.status).toBe("unconfirmed");
    expect(stored.escalatedAt).not.toBeNull();
    expect(stored.lastError).toMatch(/will not be sent again/);
    expect(daraja.callsTo(PATHS.status)).toHaveLength(3);
    expect(await prisma.notification.count({ where: { userId: reviewerId, kind: "payment_attention" } })).toBe(1);
    await runDuePayments(after(1_000_000_000));
    expect(daraja.callsTo(PATHS.b2c)).toHaveLength(1);
    expect(daraja.callsTo(PATHS.status)).toHaveLength(3);
  });

  it("a late result still settles one that was raised", async () => {
    const { activationId, disbursement } = await timedOut();
    await prisma.disbursement.update({ where: { id: disbursement.id }, data: { escalatedAt: t0 } });
    await deliver("b2c-result", disbursement.reference, b2cSuccess({ reference: disbursement.reference, conversationId: "AG_LATE", amount: 300 }));
    expect(await row(activationId)).toMatchObject({ status: "paid", escalatedAt: null });
  });
});

describe("an amount M-Pesa cannot take exactly (B2)", () => {
  afterEach(() => {
    delete process.env.MPESA_B2C_MIN_CENTS;
  });

  it("fails visibly at approval, never rounds, and the approval stands", async () => {
    process.env.MPESA_B2C_MIN_CENTS = String(COMMISSION + 100);
    const { activationId, disbursement, reviewerId } = await approved();
    expect(disbursement).toMatchObject({ status: "failed", amountCents: COMMISSION });
    expect(disbursement.failureReason).toMatch(/below the M-Pesa minimum/);
    expect((await prisma.activation.findUniqueOrThrow({ where: { id: activationId } })).state).toBe("approved");
    expect(await prisma.notification.count({ where: { userId: reviewerId, kind: "payment_attention" } })).toBe(1);
    await runDuePayments(after(1000));
    expect(daraja.callsTo(PATHS.b2c)).toHaveLength(0);
  });
});

describe("what an administrator sees (D2)", () => {
  async function page(): Promise<string> {
    return renderToStaticMarkup(await PayoutsPage());
  }

  it("shows a failed payout with its reason, raised above the rest", async () => {
    const failed = await sent();
    await deliver("b2c-result", failed.disbursement.reference, b2cFailure({ reference: failed.disbursement.reference, conversationId: failed.disbursement.conversationId!, resultCode: 1, resultDesc: "The balance is insufficient for the transaction." }));
    const html = await page();
    expect(html).toContain("Needs attention");
    expect(html).toContain("The balance is insufficient for the transaction.");
    expect(html).toContain(">Failed<");
  });

  it("shows a queued retry with its last error and next try", async () => {
    scriptB2c({ status: 500, body: { errorCode: "500.003.02", errorMessage: "System is busy. Please try again in few minutes." } });
    const { disbursement } = await approved();
    await sendDisbursement(disbursement.id, t0);
    const html = await page();
    expect(html).toContain(">Queued<");
    expect(html).toContain("System is busy");
    expect(html).toContain("Try 1 failed. Next try");
  });

  it("shows an unconfirmed payout as not to be resent, and a paid one with its receipt", async () => {
    scriptB2c({ status: 504, body: "gateway" });
    const { disbursement: unconfirmed } = await approved();
    await sendDisbursement(unconfirmed.id, t0);
    daraja.setHandler(() => undefined);
    const paid = await sent();
    await deliver("b2c-result", paid.disbursement.reference, success(paid.disbursement));
    const html = await page();
    expect(html).toContain(">Unconfirmed<");
    expect(html).toContain("may or may not have received");
    expect(html).toContain(">Paid<");
    expect(html).toContain("SG632NMUAB");
  });

  it("shows a contradiction and an unmatched callback", async () => {
    const { disbursement } = await sent();
    await deliver("b2c-result", disbursement.reference, success(disbursement, 299));
    await deliver("b2c-result", "a".repeat(32), success({ reference: "a".repeat(32), conversationId: "AG_X" }));
    const html = await page();
    expect(html).toContain("KSh 299.00 against KSh 300.00");
    expect(html).toContain("No disbursement has this reference.");
  });
});

describe("no credential reaches a log, a stored reason or an error (E1)", () => {
  it("scrubs a Daraja error that echoes credentials", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    scriptB2c({ status: 400, body: { errorCode: "400.002.02", errorMessage: "Rejected test-security-credential for test-initiator using test-consumer-secret, number 0712000000" } });
    const { activationId, disbursement } = await approved();
    await sendDisbursement(disbursement.id, t0);
    const stored = await row(activationId);
    const everything = JSON.stringify(
      [stored, await prisma.auditEvent.findMany(), await prisma.notification.findMany(), error.mock.calls, warn.mock.calls, log.mock.calls],
      (_key, value) => (typeof value === "bigint" ? String(value) : value),
    );
    error.mockRestore();
    warn.mockRestore();
    log.mockRestore();
    expect(stored.status).toBe("failed");
    for (const secret of ["test-security-credential", "test-initiator", "test-consumer-secret", "test-stk-passkey", "test-consumer-key"]) expect(everything).not.toContain(secret);
    expect(stored.failureReason).toContain("[redacted]");
  });
});
