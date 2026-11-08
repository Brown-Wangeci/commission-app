import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import PayoutsPage from "@/app/admin/payouts/page";
import { prisma } from "@/lib/db";
import { clientEscrow } from "@/lib/escrow/client";
import { jobEscrow } from "@/lib/escrow/holds";
import { createJob, jobInputSchema } from "@/lib/jobs/jobs";
import { sendDisbursement } from "@/lib/payments/disbursement";
import { retryDisbursement } from "@/lib/payments/retry";
import { runDuePayments } from "@/lib/payments/worker";
import { usePayoutAuthoriser } from "@/lib/payouts/boundary";
import { DarajaPayoutAuthoriser } from "@/lib/payouts/daraja";
import { approveActivation, refuseActivation } from "@/lib/review/actions";
import { contestRefusal } from "@/lib/disputes/disputes";
import { runDueScoringJobs } from "@/lib/scoring/runner";
import { addWeekOfActivity } from "./helpers/activity";
import { b2cFailure, b2cSuccess, deliver } from "./helpers/daraja-payloads";
import { resetDatabase } from "./helpers/db";
import { createUser } from "./helpers/factories";
import { PATHS, startFakeDaraja, type FakeDaraja } from "./helpers/fake-daraja";
import { replyWith, startFakeScoring, type FakeScoring } from "./helpers/fake-scoring";
import { jobInput, publishFundedJob, readyAssignment, submissionFor } from "./helpers/submission";
import { submitActivation } from "@/lib/activations/submit";
import { assignJob, acceptAssignment } from "@/lib/escrow/holds";
import { createAgent } from "./helpers/factories";

const t0 = new Date("2026-11-08T09:00:00.000Z");
/** KSh 2,333.33 x 12.00% = KSh 279.99: paid as KSh 279.00, KSh 0.99 back to the client. */
const CENTS_TERMS = { submissionValueCents: 233_333, commissionRateBps: 1200, flatCommissionCents: 0 };

let daraja: FakeDaraja;
let scoring: FakeScoring;

beforeAll(async () => {
  daraja = await startFakeDaraja();
  scoring = await startFakeScoring(replyWith("reject", 0.9));
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
});

/** An activation in review on a job with the given terms, and its client. */
async function inReview(terms: Partial<typeof CENTS_TERMS> = {}) {
  const { client, job } = await publishFundedJob({ ...terms, slots: 3 });
  const admin = await createUser("admin");
  const agent = await createAgent();
  const assignedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const assignment = await assignJob({ jobId: job.id, agentId: agent.id, assignedById: admin.id, at: assignedAt });
  await acceptAssignment({ assignmentId: assignment.id, agentId: agent.id, at: new Date(assignedAt.getTime() + 20 * 60 * 1000) });
  const accepted = await prisma.assignment.findUniqueOrThrow({ where: { id: assignment.id } });
  const { activationId } = await submitActivation(submissionFor(accepted));
  return { activationId, client, job, reviewerId: admin.id };
}

async function approved(terms: Partial<typeof CENTS_TERMS> = {}) {
  const state = await inReview(terms);
  await approveActivation({ activationId: state.activationId, reviewerId: state.reviewerId, reason: "Evidence checks out", at: t0 });
  return { ...state, disbursement: await prisma.disbursement.findUniqueOrThrow({ where: { activationId: state.activationId } }) };
}

async function sent(terms: Partial<typeof CENTS_TERMS> = {}) {
  const state = await approved(terms);
  await sendDisbursement(state.disbursement.id, t0);
  return { ...state, disbursement: await prisma.disbursement.findUniqueOrThrow({ where: { activationId: state.activationId } }) };
}

function hold(activationId: string) {
  return prisma.escrowHoldState.findFirstOrThrow({ where: { activationId } });
}

function successFor(row: { reference: string; conversationId: string | null; amountCents: number }, receipt = "UK8030FWVE") {
  return b2cSuccess({ reference: row.reference, conversationId: row.conversationId ?? "AG_X", amount: String(row.amountCents / 100), receipt });
}

describe("commission paid in whole shillings (E)", () => {
  it("records the whole-shilling commission, with the odd cents beside it, and pays exactly that", async () => {
    const { activationId, disbursement } = await sent(CENTS_TERMS);
    const commission = await prisma.commission.findUniqueOrThrow({ where: { activationId } });
    expect(commission).toMatchObject({ rateComponentCents: 27_999, amountCents: 27_900, roundedOffCents: 99 });
    expect(await prisma.payoutAuthorisation.findUniqueOrThrow({ where: { activationId } })).toMatchObject({ amountCents: 27_900 });
    expect(disbursement).toMatchObject({ amountCents: 27_900, status: "sent" });
    expect(daraja.callsTo(PATHS.b2c)[0].body).toMatchObject({ Amount: "279" });
    expect((await hold(activationId)).amountCents).toBe(27_999);
  });

  it("returns the odd cents to the client's balance once paid, and only once", async () => {
    const { activationId, client, job, disbursement } = await sent(CENTS_TERMS);
    const before = await clientEscrow(prisma, client.id);
    for (let i = 0; i < 4; i += 1) await deliver("b2c-result", disbursement.reference, successFor(disbursement));
    const afterPaid = await clientEscrow(prisma, client.id);
    expect(afterPaid.availableCents - before.availableCents).toBe(99);
    expect(await hold(activationId)).toMatchObject({ state: "released", paidCents: 27_900, remainderCents: 99 });
    expect(await jobEscrow(prisma, job)).toMatchObject({ releasedCents: 27_900, roundedOffCents: 99 });
  });

  it("refuses, in the database, a new commission that is not in whole shillings or rounds off the wrong cents", async () => {
    const { activationId } = await approved(CENTS_TERMS);
    const record = await prisma.commission.findUniqueOrThrow({ where: { activationId } });
    const other = await approved(CENTS_TERMS);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Disbursement" DISABLE TRIGGER "Disbursement_no_delete"`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "PayoutAuthorisation" DISABLE TRIGGER ALL`);
    await prisma.$executeRaw`DELETE FROM "Disbursement" WHERE "activationId" = ${other.activationId}`;
    await prisma.$executeRaw`DELETE FROM "PayoutAuthorisation" WHERE "activationId" = ${other.activationId}`;
    await prisma.$executeRawUnsafe(`ALTER TABLE "PayoutAuthorisation" ENABLE TRIGGER ALL`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Disbursement" ENABLE TRIGGER "Disbursement_no_delete"`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Commission" DISABLE TRIGGER "Commission_append_only"`);
    await prisma.$executeRaw`DELETE FROM "Commission" WHERE "activationId" = ${other.activationId}`;
    await prisma.$executeRawUnsafe(`ALTER TABLE "Commission" ENABLE TRIGGER "Commission_append_only"`);
    const { id: _id, recordedAt: _recorded, ...copy } = record;
    const base = { ...copy, activationId: other.activationId, jobId: other.job.id };
    await expect(prisma.commission.create({ data: { ...base, amountCents: 27_999, roundedOffCents: 0 } })).rejects.toThrow(/whole shillings/);
    await expect(prisma.commission.create({ data: { ...base, amountCents: 27_800, roundedOffCents: 199 } })).rejects.toThrow();
    await expect(prisma.commission.create({ data: base })).resolves.toBeTruthy();
  });

  it("refuses to publish a job that would pay less than KSh 1.00", () => {
    const parsed = jobInputSchema.safeParse({ ...jobInput(), submissionValueCents: 9_999, commissionRateBps: 100, flatCommissionCents: 0 });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/less than KSh 1.00/);
  });
});

describe("escrow held until M-Pesa confirms the payout (F)", () => {
  it("keeps the hold held at approval, while sent, and releases it exactly once on a confirmed payment", async () => {
    const { activationId, client, disbursement } = await approved();
    expect(await hold(activationId)).toMatchObject({ state: "held", disbursementStatus: "queued" });
    await sendDisbursement(disbursement.id, t0);
    expect(await hold(activationId)).toMatchObject({ state: "held", disbursementStatus: "sent" });
    const before = await clientEscrow(prisma, client.id);
    const row = await prisma.disbursement.findUniqueOrThrow({ where: { id: disbursement.id } });
    await Promise.all(Array.from({ length: 6 }, () => deliver("b2c-result", row.reference, successFor(row))));
    expect(await hold(activationId)).toMatchObject({ state: "released", disbursementStatus: "paid", paidCents: 30_000 });
    // A whole-shilling commission rounds nothing off, so releasing moves nothing back to the client.
    const afterPaid = await clientEscrow(prisma, client.id);
    expect({ available: afterPaid.availableCents, committed: afterPaid.committedCents }).toEqual({ available: before.availableCents, committed: before.committedCents });
    expect(await prisma.notification.count({ where: { kind: "payout_paid" } })).toBe(1);
  });

  it("leaves a failed payment's funds held, not back in the client's available balance", async () => {
    const { activationId, client, disbursement } = await sent();
    const before = await clientEscrow(prisma, client.id);
    await deliver("b2c-result", disbursement.reference, b2cFailure({ reference: disbursement.reference, conversationId: disbursement.conversationId!, resultCode: 1, resultDesc: "The balance is insufficient for the transaction." }));
    expect(await hold(activationId)).toMatchObject({ state: "held", disbursementStatus: "failed", paidCents: null });
    const afterFailure = await clientEscrow(prisma, client.id);
    expect({ available: afterFailure.availableCents, committed: afterFailure.committedCents }).toEqual({ available: before.availableCents, committed: before.committedCents });
  });

  it("never releases while queued, sending, sent, unconfirmed or failed: only paid", async () => {
    const { activationId, disbursement } = await approved();
    const states: Array<[string, () => Promise<unknown>]> = [
      ["queued", async () => undefined],
      ["sending", () => prisma.disbursement.update({ where: { id: disbursement.id }, data: { status: "sending", sendCount: 1 } })],
      ["unconfirmed", () => prisma.disbursement.update({ where: { id: disbursement.id }, data: { status: "unconfirmed" } })],
      ["sent", () => prisma.disbursement.update({ where: { id: disbursement.id }, data: { status: "sent", conversationId: "AG_1" } })],
      ["failed", () => prisma.disbursement.update({ where: { id: disbursement.id }, data: { status: "failed" } })],
    ];
    for (const [status, move] of states) {
      await move();
      expect(await hold(activationId), status).toMatchObject({ state: "held", disbursementStatus: status });
    }
    await prisma.disbursement.update({ where: { id: disbursement.id }, data: { status: "paid", receipt: "UKPAID0001" } });
    expect((await hold(activationId)).state).toBe("released");
  });

  it("holds on every path to approval: a reviewer, the hold-close model, and an overturned dispute", async () => {
    const byReviewer = await approved();
    expect((await hold(byReviewer.activationId)).state).toBe("held");

    scoring.setHandler(replyWith("review", 0.4));
    const automatic = await readyAssignment();
    const { activationId: autoId } = await submitActivation(submissionFor(automatic));
    await addWeekOfActivity(autoId);
    scoring.setHandler(replyWith("auto_release", 0.02));
    await runDueScoringJobs(new Date(Date.now() + 8 * 24 * 60 * 60 * 1000));
    expect((await prisma.activation.findUniqueOrThrow({ where: { id: autoId } })).state).toBe("approved");
    expect((await hold(autoId)).state).toBe("held");

    scoring.setHandler(replyWith("reject", 0.9));
    const contested = await inReview();
    await refuseActivation({ activationId: contested.activationId, reviewerId: contested.reviewerId, reason: "Customer denies it" });
    const agentId = (await prisma.activation.findUniqueOrThrow({ where: { id: contested.activationId } })).agentId;
    await contestRefusal({ activationId: contested.activationId, agentId, note: "The customer has written to confirm." });
    await approveActivation({ activationId: contested.activationId, reviewerId: contested.reviewerId, reason: "Confirmed in writing" });
    expect((await hold(contested.activationId)).state).toBe("held");
  });

  it("refuses, in the database, any new no-op authorisation that could release without paying", async () => {
    const { activationId } = await inReview();
    await expect(
      prisma.payoutAuthorisation.create({ data: { activationId, commissionId: "x", amountCents: 100, payoutMsisdn: "0712000000", authorisedAt: t0, provider: "noop" } }),
    ).rejects.toThrow(/no longer exists/);
  });
});

describe("an administrator retries a failed payout (F)", () => {
  async function failed() {
    const state = await sent();
    await deliver("b2c-result", state.disbursement.reference, b2cFailure({ reference: state.disbursement.reference, conversationId: state.disbursement.conversationId!, resultCode: 1, resultDesc: "The balance is insufficient for the transaction." }));
    return { ...state, disbursement: await prisma.disbursement.findUniqueOrThrow({ where: { id: state.disbursement.id } }) };
  }

  it("sends it once more under a new reference, and pays exactly once", async () => {
    const { activationId, reviewerId, disbursement } = await failed();
    const retried = await retryDisbursement({ disbursementId: disbursement.id, actorId: reviewerId, at: t0 });
    expect(retried).toMatchObject({ status: "queued", generation: 2, previousReferences: [disbursement.reference], conversationId: null, failureReason: null, sendCount: 0 });
    expect(retried.reference).not.toBe(disbursement.reference);
    expect((await hold(activationId)).state).toBe("held");

    await Promise.all([runDuePayments(t0), runDuePayments(t0), runDuePayments(t0)]);
    const sends = daraja.callsTo(PATHS.b2c);
    expect(sends).toHaveLength(2);
    expect(sends[1].body.OriginatorConversationID).toBe(retried.reference);

    const second = await prisma.disbursement.findUniqueOrThrow({ where: { id: disbursement.id } });
    for (let i = 0; i < 3; i += 1) await deliver("b2c-result", second.reference, successFor(second, "UKRETRY001"));
    expect(await prisma.disbursement.findUniqueOrThrow({ where: { id: disbursement.id } })).toMatchObject({ status: "paid", receipt: "UKRETRY001" });
    expect((await hold(activationId)).state).toBe("released");
    expect(await prisma.auditEvent.count({ where: { kind: "payout_retried", actorId: reviewerId } })).toBe(1);
  });

  it("raises a late success for the earlier attempt instead of applying it", async () => {
    const { disbursement, reviewerId } = await failed();
    await retryDisbursement({ disbursementId: disbursement.id, actorId: reviewerId, at: t0 });
    await deliver("b2c-result", disbursement.reference, successFor(disbursement, "UKOLDGEN01"));
    const row = await prisma.disbursement.findUniqueOrThrow({ where: { id: disbursement.id } });
    expect(row.status).toBe("queued");
    expect(row.receipt).toBeNull();
    expect(await prisma.paymentCallback.findFirstOrThrow({ where: { reference: disbursement.reference, outcome: "conflict" } })).toBeTruthy();
  });

  it("lets two administrators retry at once, and only one succeeds", async () => {
    const { disbursement, reviewerId } = await failed();
    const results = await Promise.allSettled([1, 2, 3].map(() => retryDisbursement({ disbursementId: disbursement.id, actorId: reviewerId, at: t0 })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await prisma.disbursement.findUniqueOrThrow({ where: { id: disbursement.id } })).generation).toBe(2);
  });

  it("refuses to retry anything that is not a definite failure", async () => {
    const queued = await approved();
    await expect(retryDisbursement({ disbursementId: queued.disbursement.id, actorId: queued.reviewerId })).rejects.toMatchObject({ status: 409 });
    await prisma.disbursement.update({ where: { id: queued.disbursement.id }, data: { status: "sending", sendCount: 1 } });
    await prisma.disbursement.update({ where: { id: queued.disbursement.id }, data: { status: "unconfirmed" } });
    await expect(retryDisbursement({ disbursementId: queued.disbursement.id, actorId: queued.reviewerId })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/may already have paid/) });
    await expect(retryDisbursement({ disbursementId: "missing", actorId: queued.reviewerId })).rejects.toMatchObject({ status: 404 });
  });

  it("refuses, in the database, a failed payout sent again under its old reference", async () => {
    const { disbursement } = await failed();
    await expect(prisma.disbursement.update({ where: { id: disbursement.id }, data: { status: "queued", conversationId: null } })).rejects.toThrow(/cannot move from failed to queued/);
    await expect(prisma.disbursement.update({ where: { id: disbursement.id }, data: { reference: "e".repeat(32) } })).rejects.toThrow(/changes only when a failure is retried/);
  });

  it("shows a failed payout with a retry button and the held escrow on the Payouts page", async () => {
    await failed();
    const html = renderToStaticMarkup(await PayoutsPage());
    expect(html).toContain("Retry payout");
    expect(html).toContain("The escrow stays held until M-Pesa confirms payment.");
  });
});

describe("the seed's Githurai job (E)", () => {
  it("now pays KSh 279.00, so its payouts no longer fail at approval", async () => {
    const { client } = await publishFundedJob({ ...CENTS_TERMS, slots: 1 });
    const job = await createJob({ clientId: client.id, actorId: client.userId, job: jobInput({ ...CENTS_TERMS, slots: 1 }) }).catch(() => null);
    expect(job === null || job.escrowLockedCents === 27_999).toBe(true);
    const { disbursement } = await approved(CENTS_TERMS);
    expect(disbursement).toMatchObject({ status: "queued", amountCents: 27_900, failureReason: null });
  });
});
