import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { respondToEvidenceRequest, withdrawActivation } from "@/lib/activations/agent-actions";
import { submitActivation } from "@/lib/activations/submit";
import { approveActivation, refuseActivation, requestEvidence } from "@/lib/review/actions";
import { reviewDetail, summariseEvidence } from "@/lib/review/detail";
import { listQueue, queuePosition } from "@/lib/review/queue";
import { resetDatabase } from "./helpers/db";
import { replyWith, startFakeScoring, type FakeScoring } from "./helpers/fake-scoring";
import { createUser } from "./helpers/factories";
import { photo, readyAssignment, submissionFor, submitReady } from "./helpers/submission";

let fake: FakeScoring;

beforeAll(async () => {
  fake = await startFakeScoring(replyWith("reject", 0.88));
  process.env.SCORING_SERVICE_URL = fake.url;
});
afterAll(() => fake.close());
beforeEach(async () => {
  await resetDatabase();
  fake.setHandler(replyWith("reject", 0.88));
});

/** An activation in review (T0 reject escalates straight to a reviewer). */
async function inReview(overrides = {}) {
  return (await submitReady(overrides)).activationId;
}

describe("review queue listing (issue #9)", () => {
  it("lists activations waiting for a reviewer, oldest first, with reasons kept apart by level", async () => {
    const first = await inReview();
    const second = await inReview();
    const rows = await listQueue(prisma, "waiting");
    expect(rows.map((r) => r.id)).toEqual([first, second]);
    expect(rows[0].submissionReasons.every((r) => !r.isAgentLevel)).toBe(true);
    expect(rows[0].agentReasons.every((r) => r.isAgentLevel)).toBe(true);
    expect(rows[0].agentReasons).toHaveLength(1);
    expect(rows[0].latest).toMatchObject({ mode: "t0", band: "reject", releaseThreshold: 0.301471 });
    expect(rows[0].amount).toMatchObject({ amountCents: 30_000, basis: "job_terms" });
  });

  it("gives each item its position and neighbours", async () => {
    const ids = [await inReview(), await inReview(), await inReview()];
    expect(await queuePosition(prisma, ids[1])).toEqual({ index: 2, total: 3, previousId: ids[0], nextId: ids[2] });
    expect((await queuePosition(prisma, ids[0]))?.previousId).toBeNull();
  });
});

describe("review actions (issue #9)", () => {
  it("approves, recording who, when, why and the decision in force", async () => {
    const reviewer = await createUser("admin");
    const id = await inReview();
    await approveActivation({ activationId: id, reviewerId: reviewer.id, reason: "Customer confirmed by phone" });
    const activation = await prisma.activation.findUniqueOrThrow({ where: { id }, include: { reviewItems: true, decisions: true } });
    expect(activation.state).toBe("approved");
    expect(activation.reviewItems[0]).toMatchObject({
      action: "approved", reviewerId: reviewer.id, reason: "Customer confirmed by phone", decisionId: activation.decisions[0].id,
    });
    expect(activation.reviewItems[0].closedAt).not.toBeNull();
    const transition = await prisma.auditEvent.findFirstOrThrow({ where: { activationId: id, toState: "approved" } });
    expect(transition.actorId).toBe(reviewer.id);
    const agentUser = (await prisma.agent.findUniqueOrThrow({ where: { id: activation.agentId } })).userId;
    expect(await prisma.notification.count({ where: { userId: agentUser, kind: "approved" } })).toBe(1);
  });

  it("refuses with a recorded reason", async () => {
    const reviewer = await createUser("admin");
    const id = await inReview();
    await refuseActivation({ activationId: id, reviewerId: reviewer.id, reason: "Photos were taken elsewhere" });
    expect((await prisma.activation.findUniqueOrThrow({ where: { id } })).state).toBe("refused");
  });

  it("will not decide an activation that is not in review", async () => {
    const reviewer = await createUser("admin");
    fake.setHandler(replyWith("review", 0.4));
    const { activationId } = await submitReady();
    await expect(
      approveActivation({ activationId, reviewerId: reviewer.id, reason: "looks fine" }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("ask for evidence (correction 3)", () => {
  it("parks the item, records the request and notifies the agent", async () => {
    const reviewer = await createUser("admin");
    const id = await inReview();
    await requestEvidence({ activationId: id, reviewerId: reviewer.id, reason: "Send a photo of the signed form" });
    const activation = await prisma.activation.findUniqueOrThrow({ where: { id }, include: { evidenceRequests: true, agent: true } });
    expect(activation.state).toBe("awaiting_evidence");
    expect(activation.evidenceRequests[0]).toMatchObject({ requestedById: reviewer.id, message: "Send a photo of the signed form", status: "open" });
    expect(await prisma.notification.count({ where: { userId: activation.agent.userId, kind: "evidence_requested" } })).toBe(1);
    expect((await listQueue(prisma, "waiting")).map((r) => r.id)).not.toContain(id);
    expect((await listQueue(prisma, "evidence"))[0]).toMatchObject({ id, evidenceAsked: "Send a photo of the signed form" });
  });

  it("returns the item to the queue when the agent responds", async () => {
    const reviewer = await createUser("admin");
    const id = await inReview();
    const agentId = (await prisma.activation.findUniqueOrThrow({ where: { id } })).agentId;
    await requestEvidence({ activationId: id, reviewerId: reviewer.id, reason: "Send a photo of the signed form" });
    await respondToEvidenceRequest({
      agentId, activationId: id, note: "Form attached",
      photos: [{ file: photo("form.png"), capturedAt: new Date(), gpsLat: -1.28, gpsLon: 36.83, gpsAccuracyM: 5, locationSource: "device" }],
    });
    const activation = await prisma.activation.findUniqueOrThrow({
      where: { id }, include: { evidenceRequests: { include: { items: true } }, reviewItems: { orderBy: { openedAt: "asc" } } },
    });
    expect(activation.state).toBe("in_review");
    expect(activation.evidenceRequests[0]).toMatchObject({ status: "answered", responseNote: "Form attached" });
    expect(activation.evidenceRequests[0].items.map((i) => i.sequence)).toEqual([4]);
    expect(activation.reviewItems.at(-1)?.openReason).toBe("evidence_returned");
    expect(await prisma.notification.count({ where: { userId: reviewer.id, kind: "evidence_returned" } })).toBe(1);
    expect((await listQueue(prisma, "waiting")).map((r) => r.id)).toContain(id);
  });

  it("needs a note or a photo, and only from the activation's own agent", async () => {
    const reviewer = await createUser("admin");
    const id = await inReview();
    const agentId = (await prisma.activation.findUniqueOrThrow({ where: { id } })).agentId;
    await requestEvidence({ activationId: id, reviewerId: reviewer.id, reason: "More please" });
    await expect(respondToEvidenceRequest({ agentId, activationId: id, note: null, photos: [] })).rejects.toMatchObject({ status: 400 });
    await expect(respondToEvidenceRequest({ agentId: "other", activationId: id, note: "x", photos: [] })).rejects.toMatchObject({ status: 404 });
  });
});

describe("withdrawal", () => {
  it("withdraws a held activation and cancels its pending T7 score", async () => {
    fake.setHandler(replyWith("review", 0.4));
    const { activationId } = await submitReady();
    const agentId = (await prisma.activation.findUniqueOrThrow({ where: { id: activationId } })).agentId;
    await withdrawActivation({ agentId, activationId, reason: "Customer changed their mind" });
    expect((await prisma.activation.findUniqueOrThrow({ where: { id: activationId } })).state).toBe("withdrawn");
    const job = await prisma.scoringJob.findFirstOrThrow({ where: { activationId, mode: "t7" } });
    expect(job.status).toBe("cancelled");
  });
});

describe("review detail (issue #9)", () => {
  it("assembles the screen from records, with unavailable values left null", async () => {
    const first = await readyAssignment();
    await submitActivation(submissionFor(first, { submittedAt: new Date(Date.now() - 40 * 60 * 1000), gpsLat: -1.05, gpsLon: 37.08 }));
    const second = await readyAssignment({ agentId: first.agentId });
    const far = { file: photo("far.png"), capturedAt: new Date(), gpsLat: -1.35, gpsLon: 36.95, gpsAccuracyM: 12, locationSource: "device" as const };
    const result = await submitActivation(
      submissionFor(second, { values: { customerMsisdn: "0700111222" }, photos: { field_1: [...submissionFor(second).photos.field_1, far] } }),
    );
    const detail = await reviewDetail(prisma, result.activationId);

    expect(detail.photos).toHaveLength(3);
    expect(detail.proof).not.toBeNull();
    expect(detail.evidenceSummary.outside.map((o) => o.sequence)).toEqual([3]);
    expect(detail.evidenceSummary.withoutLocation).toBe(1);
    expect(detail.previous?.distanceKm).toBeGreaterThan(20);
    expect(detail.previous?.gapMs).toBeGreaterThan(30 * 60 * 1000);
    expect(detail.agent.stats).toMatchObject({ total: 2, approved: 0, rejected: 0, approvalRate: null });
    expect(detail.latest?.releaseThreshold).toBeCloseTo(0.301471);
    expect(detail.concern?.feature).toBe("distance_from_agent_home_km");
    expect(detail.actions).toMatchObject({ canApprove: true, canRequestEvidence: true });
    expect(detail.position).toMatchObject({ total: 2 });
    expect(detail.payout).toMatchObject({ amount: { amountCents: 30_000, basis: "job_terms", commission: { derivation: "KSh 3,000.00 × 10.00% = KSh 300.00" } }, payoutMsisdn: "0712000000" });
  });

  it("summarises capture windows and accuracy only from recorded values", () => {
    const summary = summariseEvidence([], false);
    expect(summary).toMatchObject({ photoCount: 0, captureStart: null, accuracyMin: null, outside: [] });
  });
});
