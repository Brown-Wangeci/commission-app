import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { contestRefusal } from "@/lib/disputes/disputes";
import { approveActivation, refuseActivation } from "@/lib/review/actions";
import { listQueue } from "@/lib/review/queue";
import { runDueScoringJobs } from "@/lib/scoring/runner";
import { addWeekOfActivity } from "./helpers/activity";
import { resetDatabase } from "./helpers/db";
import { replyWith, startFakeScoring, type FakeScoring } from "./helpers/fake-scoring";
import { createUser } from "./helpers/factories";
import { submitReady } from "./helpers/submission";

let fake: FakeScoring;

beforeAll(async () => {
  fake = await startFakeScoring();
  process.env.SCORING_SERVICE_URL = fake.url;
});
afterAll(() => fake.close());
beforeEach(async () => {
  await resetDatabase();
  fake.setHandler(replyWith("reject", 0.88));
});

async function inReview() {
  const { activationId } = await submitReady();
  const agentId = (await prisma.activation.findUniqueOrThrow({ where: { id: activationId } })).agentId;
  return { activationId, agentId };
}

describe("disputes (issue #10)", () => {
  it("creates a dispute carrying the reason and the decision when a reviewer refuses", async () => {
    const reviewer = await createUser("admin");
    const { activationId } = await inReview();
    await refuseActivation({ activationId, reviewerId: reviewer.id, reason: "Customer denies signing up" });
    const dispute = await prisma.dispute.findUniqueOrThrow({ where: { activationId } });
    const decision = await prisma.scoringDecision.findFirstOrThrow({ where: { activationId } });
    const item = await prisma.reviewItem.findFirstOrThrow({ where: { activationId, action: "refused" } });
    expect(dispute).toMatchObject({
      status: "open", refusalReason: "Customer denies signing up", refusedById: reviewer.id, decisionId: decision.id, reviewItemId: item.id,
    });
  });

  it("creates a dispute linked to the T7 decision when the model refuses automatically", async () => {
    fake.setHandler(replyWith("review", 0.4));
    const { activationId } = await submitReady();
    await addWeekOfActivity(activationId, false);
    fake.setHandler(replyWith("reject", 0.93));
    await runDueScoringJobs(new Date(Date.now() + 8 * 24 * 60 * 60 * 1000));
    const t7 = await prisma.scoringDecision.findFirstOrThrow({ where: { activationId, mode: "t7" } });
    const dispute = await prisma.dispute.findUniqueOrThrow({ where: { activationId } });
    expect(dispute.decisionId).toBe(t7.id);
    expect(dispute.refusedById).toBeNull();
    expect(dispute.refusalReason).toContain("93.0%");
    expect(dispute.refusalReason).toContain("66.7%");
  });

  it("creates no dispute when a payout is approved", async () => {
    const reviewer = await createUser("admin");
    const { activationId } = await inReview();
    await approveActivation({ activationId, reviewerId: reviewer.id, reason: "All checks pass" });
    expect(await prisma.dispute.count({ where: { activationId } })).toBe(0);
  });

  it("lets the agent contest once, returning it to the queue", async () => {
    const reviewer = await createUser("admin");
    const { activationId, agentId } = await inReview();
    await refuseActivation({ activationId, reviewerId: reviewer.id, reason: "Photos taken elsewhere" });
    await contestRefusal({ agentId, activationId, note: "I was at the market, the GPS was wrong" });
    expect((await prisma.activation.findUniqueOrThrow({ where: { id: activationId } })).state).toBe("disputed");
    expect((await prisma.dispute.findUniqueOrThrow({ where: { activationId } })).status).toBe("contested");
    expect((await listQueue(prisma, "waiting")).map((r) => r.id)).toContain(activationId);
    expect(await prisma.notification.count({ where: { userId: reviewer.id, kind: "dispute" } })).toBe(1);

    await refuseActivation({ activationId, reviewerId: reviewer.id, reason: "Upheld: second photo also off-site" });
    const dispute = await prisma.dispute.findUniqueOrThrow({ where: { activationId } });
    expect(dispute).toMatchObject({ status: "upheld", resolvedById: reviewer.id });
    await expect(contestRefusal({ agentId, activationId, note: "again please" })).rejects.toMatchObject({ status: 409 });
  });

  it("marks the dispute overturned when the contested refusal is approved", async () => {
    const reviewer = await createUser("admin");
    const { activationId, agentId } = await inReview();
    await refuseActivation({ activationId, reviewerId: reviewer.id, reason: "No proof attached" });
    await contestRefusal({ agentId, activationId, note: "Proof was attached, please look again" });
    await approveActivation({ activationId, reviewerId: reviewer.id, reason: "Proof found on second look" });
    expect((await prisma.dispute.findUniqueOrThrow({ where: { activationId } })).status).toBe("overturned");
    expect((await prisma.activation.findUniqueOrThrow({ where: { id: activationId } })).state).toBe("approved");
  });

  it("does not let another agent contest", async () => {
    const reviewer = await createUser("admin");
    const { activationId } = await inReview();
    await refuseActivation({ activationId, reviewerId: reviewer.id, reason: "No proof attached" });
    await expect(contestRefusal({ agentId: "someone-else", activationId, note: "not mine" })).rejects.toMatchObject({ status: 404 });
  });
});
