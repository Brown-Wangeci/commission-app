import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { submitActivation } from "@/lib/activations/submit";
import { toServiceTime } from "@/lib/scoring/time";
import { resetDatabase } from "./helpers/db";
import { replyWith, startFakeScoring, type FakeScoring } from "./helpers/fake-scoring";
import { readyAssignment, submissionFor, submitReady } from "./helpers/submission";

let fake: FakeScoring;

beforeAll(async () => {
  fake = await startFakeScoring();
  process.env.SCORING_SERVICE_URL = fake.url;
  process.env.HOLD_WINDOW_SECONDS = "604800";
});
afterAll(() => fake.close());
beforeEach(async () => {
  await resetDatabase();
  fake.requests.length = 0;
  fake.setHandler(replyWith("review", 0.42));
});

describe("T0 scoring at submission (issue #6)", () => {
  it("calls the service in mode t0 with no downstream activity", async () => {
    const result = await submitReady();
    expect(fake.requests).toHaveLength(1);
    const sent = fake.requests[0];
    expect(sent.mode).toBe("t0");
    expect(sent.downstream_activity).toEqual([]);
    expect(sent.activation.activation_id).toBe(result.activationId);
    expect(sent.activation.proof_of_activation_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sent.agents.map((a) => a.agent_id)).toContain(sent.activation.agent_id);
    expect(sent.payout_calendar.length).toBeGreaterThan(0);
  });

  it("sends Nairobi wall-clock time without an offset", async () => {
    const assignment = await readyAssignment();
    const submittedAt = new Date("2026-10-14T07:42:00.000Z");
    await prisma.assignment.update({
      where: { id: assignment.id },
      data: { assignedAt: new Date("2026-10-14T05:00:00Z"), acceptedAt: new Date("2026-10-14T05:30:00Z") },
    });
    const updated = await prisma.assignment.findUniqueOrThrow({ where: { id: assignment.id } });
    await submitActivation(
      submissionFor(updated, { submittedAt, simRegisteredAt: new Date("2026-09-01T00:00:00Z") }),
    );
    expect(fake.requests[0].activation.timestamp_submitted).toBe("2026-10-14T10:42:00.000");
    expect(toServiceTime(submittedAt)).toBe("2026-10-14T10:42:00.000");
  });

  it("sends the agent's earlier activations as history for the trailing-window features", async () => {
    const first = await readyAssignment();
    await submitActivation(submissionFor(first, { submittedAt: new Date(Date.now() - 60 * 60 * 1000) }));
    const second = await readyAssignment({ agentId: first.agentId });
    await submitActivation(submissionFor(second, { customerMsisdn: "0799888777" }));
    const historySent = fake.requests[1].recent_activations.map((a) => a.agent_id);
    expect(historySent).toEqual([first.agentId]);
  });

  it("stores the decision and holds the activation for a review band", async () => {
    const result = await submitReady();
    expect(result.state).toBe("held");
    const activation = await prisma.activation.findUniqueOrThrow({
      where: { id: result.activationId },
      include: { decisions: { include: { reasons: true } }, scoringJobs: true },
    });
    expect(activation.decisions).toHaveLength(1);
    expect(activation.decisions[0]).toMatchObject({ mode: "t0", band: "review", trigger: "submission" });
    expect(activation.decisions[0].reasons).toHaveLength(3);
    const window = activation.holdClosesAt!.getTime() - activation.heldAt!.getTime();
    expect(window).toBe(604800 * 1000);
    const t7 = activation.scoringJobs.find((job) => job.mode === "t7");
    expect(t7).toMatchObject({ status: "pending", trigger: "hold_close" });
    expect(t7?.dueAt.getTime()).toBe(activation.holdClosesAt!.getTime());
  });

  it("holds an auto_release at T0 rather than paying it", async () => {
    fake.setHandler(replyWith("auto_release", 0.05));
    const result = await submitReady();
    expect(result.state).toBe("held");
  });

  it("sends a T0 reject straight to a reviewer", async () => {
    fake.setHandler(replyWith("reject", 0.91));
    const result = await submitReady();
    expect(result.state).toBe("in_review");
    const item = await prisma.reviewItem.findFirstOrThrow({ where: { activationId: result.activationId } });
    expect(item.openReason).toBe("t0_reject_escalation");
  });

  it("refuses a submission for another agent's assignment", async () => {
    const assignment = await readyAssignment();
    await expect(submitActivation({ ...submissionFor(assignment), agentId: "someone-else" })).rejects.toMatchObject({
      status: 404,
    });
  });

  it("refuses a SIM registration date after the submission", async () => {
    await expect(
      submitReady({ simRegisteredAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000) }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a second activation for the same assignment", async () => {
    const assignment = await readyAssignment();
    await submitActivation(submissionFor(assignment));
    await expect(submitActivation(submissionFor(assignment))).rejects.toMatchObject({ status: 409 });
  });
});
