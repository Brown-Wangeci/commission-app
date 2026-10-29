import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { contestRefusal } from "@/lib/disputes/disputes";
import { clientEscrowView } from "@/lib/jobs/jobs";
import { approveActivation, refuseActivation } from "@/lib/review/actions";
import { reviewDetail } from "@/lib/review/detail";
import { runDueScoringJobs } from "@/lib/scoring/runner";
import { usePayoutAuthoriser } from "@/lib/payouts/boundary";
import { NoopPayoutAuthoriser } from "@/lib/payouts/noop";
import { addWeekOfActivity } from "./helpers/activity";
import { resetDatabase } from "./helpers/db";
import { replyWith, startFakeScoring, type FakeScoring } from "./helpers/fake-scoring";
import { createAgent, createUser } from "./helpers/factories";
import { publishFundedJob, submissionFor } from "./helpers/submission";
import { acceptAssignment, assignJob } from "@/lib/escrow/holds";
import { submitActivation } from "@/lib/activations/submit";

let fake: FakeScoring;

beforeAll(async () => {
  fake = await startFakeScoring();
  process.env.SCORING_SERVICE_URL = fake.url;
});
afterAll(() => fake.close());
beforeEach(async () => {
  await resetDatabase();
  fake.setHandler(replyWith("reject", 0.9));
  usePayoutAuthoriser(new NoopPayoutAuthoriser());
});

/**
 * A submitted activation on a job with a rate that does not land on a whole
 * cent and a flat amount: KSh 1,234.56 x 8.25% = KSh 101.8512, floored to
 * KSh 101.85, plus KSh 20.00 flat = KSh 121.85.
 */
const TERMS = { submissionValueCents: 123_456, commissionRateBps: 825, flatCommissionCents: 2_000 };
const EXPECTED = { rateComponentCents: 10_185, amountCents: 12_185 };

async function submitted(): Promise<{ activationId: string; clientId: string }> {
  const { client, job } = await publishFundedJob({ ...TERMS, slots: 4 });
  const admin = await createUser("admin");
  const agent = await createAgent();
  const assignedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const assignment = await assignJob({ jobId: job.id, agentId: agent.id, assignedById: admin.id, at: assignedAt });
  await acceptAssignment({ assignmentId: assignment.id, agentId: agent.id, at: new Date(assignedAt.getTime() + 20 * 60 * 1000) });
  const accepted = await prisma.assignment.findUniqueOrThrow({ where: { id: assignment.id } });
  const { activationId } = await submitActivation(submissionFor(accepted));
  return { activationId, clientId: client.id };
}

describe("commission at approval (FR-18, issue #41)", () => {
  it("records exactly one commission when a reviewer approves, carrying the structure in force", async () => {
    const reviewer = await createUser("admin");
    const { activationId } = await submitted();
    await approveActivation({ activationId, reviewerId: reviewer.id, reason: "Customer confirmed by phone" });
    const commissions = await prisma.commission.findMany({ where: { activationId } });
    expect(commissions).toHaveLength(1);
    expect(commissions[0]).toMatchObject({ ...TERMS, ...EXPECTED, approvedById: reviewer.id });
  });

  it("pays the computed commission, not a flat figure, through the payout authorisation", async () => {
    const reviewer = await createUser("admin");
    const { activationId } = await submitted();
    await approveActivation({ activationId, reviewerId: reviewer.id, reason: "Customer confirmed by phone" });
    const payout = await prisma.payoutAuthorisation.findUniqueOrThrow({ where: { activationId }, include: { commission: true } });
    expect(payout.amountCents).toBe(EXPECTED.amountCents);
    expect(payout.commission.activationId).toBe(activationId);
    const hold = await prisma.escrowHoldState.findFirstOrThrow({ where: { activationId } });
    expect(hold).toMatchObject({ amountCents: EXPECTED.amountCents, state: "released" });
  });

  it("records exactly one commission on automatic release at hold-close", async () => {
    fake.setHandler(replyWith("review", 0.4));
    const { activationId } = await submitted();
    await addWeekOfActivity(activationId);
    fake.setHandler(replyWith("auto_release", 0.02));
    await runDueScoringJobs(new Date(Date.now() + 8 * 24 * 60 * 60 * 1000));
    expect((await prisma.activation.findUniqueOrThrow({ where: { id: activationId } })).state).toBe("approved");
    const commissions = await prisma.commission.findMany({ where: { activationId } });
    expect(commissions).toHaveLength(1);
    expect(commissions[0]).toMatchObject({ ...EXPECTED, approvedById: null });
  });

  it("records exactly one commission when a contested refusal is overturned, and none on refusal", async () => {
    const reviewer = await createUser("admin");
    const { activationId } = await submitted();
    await refuseActivation({ activationId, reviewerId: reviewer.id, reason: "Customer denies it" });
    expect(await prisma.commission.count()).toBe(0);
    const activation = await prisma.activation.findUniqueOrThrow({ where: { id: activationId }, include: { agent: true } });
    await contestRefusal({ activationId, agentId: activation.agentId, note: "The customer has written to confirm." });
    await approveActivation({ activationId, reviewerId: reviewer.id, reason: "Customer confirmed in writing" });
    expect(await prisma.commission.count({ where: { activationId } })).toBe(1);
  });

  it("cannot record a second commission: a repeat approval is refused and leaves one record", async () => {
    const reviewer = await createUser("admin");
    const { activationId } = await submitted();
    await approveActivation({ activationId, reviewerId: reviewer.id, reason: "Customer confirmed by phone" });
    await expect(approveActivation({ activationId, reviewerId: reviewer.id, reason: "Approving again" })).rejects.toMatchObject({ status: 409 });
    const first = await prisma.commission.findUniqueOrThrow({ where: { activationId } });
    await expect(prisma.commission.create({ data: { ...first, id: undefined, recordedAt: undefined } })).rejects.toThrow();
    expect(await prisma.commission.count({ where: { activationId } })).toBe(1);
  });

  it("refuses, in the database, a commission that is altered, deleted, inconsistent or not for an approved activation", async () => {
    const reviewer = await createUser("admin");
    const { activationId } = await submitted();
    const other = await submitted();
    await approveActivation({ activationId, reviewerId: reviewer.id, reason: "Customer confirmed by phone" });
    const record = await prisma.commission.findUniqueOrThrow({ where: { activationId } });
    await expect(prisma.commission.update({ where: { id: record.id }, data: { amountCents: 99_999 } })).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`DELETE FROM "Commission" WHERE id = ${record.id}`).rejects.toThrow(/append-only/);
    const base = { activationId: other.activationId, jobId: record.jobId, computedAt: new Date(), ...TERMS, ...EXPECTED };
    // The other activation is in review, not approved.
    await expect(prisma.commission.create({ data: base })).rejects.toThrow(/approved activation/);
    // An amount that does not follow from the structure.
    await expect(prisma.commission.create({ data: { ...base, activationId, amountCents: EXPECTED.amountCents + 1 } })).rejects.toThrow();
  });

  it("exposes the commission and its derivation in the review API, before and after approval", async () => {
    const reviewer = await createUser("admin");
    const { activationId } = await submitted();
    const derivation = "KSh 1,234.56 × 8.25% = KSh 101.85 (rounded down to the cent) + KSh 20.00 flat";
    const before = await reviewDetail(prisma, activationId);
    expect(before.payout.amount).toMatchObject({ amountCents: EXPECTED.amountCents, basis: "job_terms", commission: { derivation, roundedDown: true } });
    await approveActivation({ activationId, reviewerId: reviewer.id, reason: "Customer confirmed by phone" });
    const after = await reviewDetail(prisma, activationId);
    expect(after.payout.amount).toMatchObject({ amountCents: EXPECTED.amountCents, basis: "recorded", commission: { derivation } });
  });

  it("exposes the client's balance, each job's commission and its lock, each with a derivation", async () => {
    const { clientId } = await submitted();
    const view = await clientEscrowView(clientId);
    expect(view).toMatchObject({
      depositedCents: 4 * EXPECTED.amountCents,
      availableCents: 0,
      availableDerivation: "KSh 487.40 deposited − KSh 487.40 committed to 1 job",
    });
    expect(view.jobs[0].terms.liability).toMatchObject({ amountCents: 4 * EXPECTED.amountCents, derivation: "4 × KSh 121.85 per approved submission" });
  });
});
