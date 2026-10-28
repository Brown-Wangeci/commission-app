import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { runDueScoringJobs } from "@/lib/scoring/runner";
import { scoringHealth } from "@/lib/scoring/status";
import { addWeekOfActivity } from "./helpers/activity";
import { resetDatabase } from "./helpers/db";
import { replyWith, startFakeScoring, type FakeScoring } from "./helpers/fake-scoring";
import { submitReady } from "./helpers/submission";

let fake: FakeScoring;
const LATER = () => new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);

beforeAll(async () => {
  fake = await startFakeScoring();
});
afterAll(() => fake.close());
beforeEach(async () => {
  await resetDatabase();
  fake.requests.length = 0;
  fake.setHandler(replyWith("review", 0.4));
  process.env.SCORING_SERVICE_URL = fake.url;
  process.env.SCORING_TIMEOUT_MS = "300";
  process.env.SCORING_IMMEDIATE_ATTEMPTS = "3";
  process.env.SCORING_IMMEDIATE_BACKOFF_MS = "5";
  process.env.SCORING_RETRY_BASE_SECONDS = "60";
  process.env.SCORING_MAX_RUNS = "3";
  process.env.HOLD_WINDOW_SECONDS = "604800";
});

async function stateOf(id: string) {
  return prisma.activation.findUniqueOrThrow({ where: { id } });
}

async function failedKinds(id: string): Promise<string[]> {
  const attempts = await prisma.scoringAttempt.findMany({ where: { activationId: id }, orderBy: { attemptedAt: "asc" } });
  return attempts.map((a) => a.errorKind ?? "ok");
}

describe("scoring failures at submission (issue #8)", () => {
  it("routes to review, flagged, when the service is down", async () => {
    process.env.SCORING_SERVICE_URL = "http://127.0.0.1:9";
    const { activationId, state } = await submitReady();
    expect(state).toBe("in_review");
    const activation = await stateOf(activationId);
    expect(activation.unscoredStage).toBe("t0");
    expect(await failedKinds(activationId)).toEqual(["unavailable", "unavailable", "unavailable"]);
    const item = await prisma.reviewItem.findFirstOrThrow({ where: { activationId } });
    expect(item.openReason).toBe("could_not_be_scored");
    const job = await prisma.scoringJob.findFirstOrThrow({ where: { activationId, mode: "t0" } });
    expect(job.status).toBe("pending");
    expect(job.dueAt.getTime()).toBeGreaterThan(Date.now());
    const health = await scoringHealth(prisma, activationId, activation.unscoredStage);
    expect(health).toMatchObject({ unscoredStage: "t0", failedAttempts: 3, gaveUp: false });
    expect(health.pendingRetry?.mode).toBe("t0");
  });

  it("treats a slow service as a timeout", async () => {
    fake.setHandler((request) => ({ ...replyWith("auto_release", 0.05)(request), delayMs: 1000 }));
    const { activationId, state } = await submitReady();
    expect(state).toBe("in_review");
    expect(await failedKinds(activationId)).toEqual(["timeout", "timeout", "timeout"]);
  });

  it("treats a 500 as a server error and retries it", async () => {
    fake.setHandler(() => ({ status: 500, body: { detail: "model not loaded" } }));
    const { activationId } = await submitReady();
    expect(await failedKinds(activationId)).toEqual(["server_error", "server_error", "server_error"]);
  });

  it("treats a malformed 200 as an invalid response, not a score", async () => {
    fake.setHandler((request) => ({ status: 200, body: { activation_id: request.activation.activation_id, band: "auto_release" } }));
    const { activationId, state } = await submitReady();
    expect(state).toBe("in_review");
    expect(await failedKinds(activationId)).toEqual(["invalid_response", "invalid_response", "invalid_response"]);
    expect(await prisma.scoringDecision.count({ where: { activationId } })).toBe(0);
  });

  it("does not retry a rejected request straight away", async () => {
    fake.setHandler(() => ({ status: 422, body: { detail: "mode 't0' must not include downstream_activity" } }));
    const { activationId } = await submitReady();
    expect(await failedKinds(activationId)).toEqual(["rejected_request"]);
  });

  it("recovers on a later retry without releasing anything", async () => {
    fake.setHandler(() => ({ status: 503, body: { detail: "down" } }));
    const { activationId } = await submitReady();
    fake.setHandler(replyWith("auto_release", 0.02));
    const summary = await runDueScoringJobs(new Date(Date.now() + 5 * 60 * 1000));
    expect(summary.advisory).toBe(1);
    const activation = await stateOf(activationId);
    expect(activation.state).toBe("in_review");
    expect(activation.unscoredStage).toBeNull();
    expect(await prisma.scoringDecision.count({ where: { activationId } })).toBe(1);
  });

  it("gives up after SCORING_MAX_RUNS runs and leaves it with the reviewer", async () => {
    process.env.SCORING_SERVICE_URL = "http://127.0.0.1:9";
    process.env.SCORING_IMMEDIATE_ATTEMPTS = "1";
    const { activationId } = await submitReady();
    await runDueScoringJobs(new Date(Date.now() + 2 * 60 * 1000));
    await runDueScoringJobs(new Date(Date.now() + 10 * 60 * 1000));
    const job = await prisma.scoringJob.findFirstOrThrow({ where: { activationId, mode: "t0" } });
    expect(job.status).toBe("failed");
    expect((await stateOf(activationId)).state).toBe("in_review");
    expect((await scoringHealth(prisma, activationId, "t0")).gaveUp).toBe(true);
  });
});

describe("scoring failures at hold-close (issue #8)", () => {
  it("never auto-releases a held activation the T7 model could not score", async () => {
    const { activationId } = await submitReady();
    await addWeekOfActivity(activationId);
    process.env.SCORING_SERVICE_URL = "http://127.0.0.1:9";
    await runDueScoringJobs(LATER());
    const activation = await stateOf(activationId);
    expect(activation.state).toBe("in_review");
    expect(activation.unscoredStage).toBe("t7");

    process.env.SCORING_SERVICE_URL = fake.url;
    fake.setHandler(replyWith("auto_release", 0.01));
    await runDueScoringJobs(new Date(LATER().getTime() + 10 * 60 * 1000));
    const after = await stateOf(activationId);
    expect(after.state).toBe("in_review");
    expect(after.unscoredStage).toBeNull();
  });

  it("does not call the service without first-week activity, and says why", async () => {
    const { activationId } = await submitReady();
    const before = fake.requests.length;
    await runDueScoringJobs(LATER());
    expect(fake.requests.length).toBe(before);
    expect((await stateOf(activationId)).state).toBe("in_review");
    const attempt = await prisma.scoringAttempt.findFirstOrThrow({ where: { activationId, mode: "t7" } });
    expect(attempt).toMatchObject({ errorKind: "missing_input" });
    expect(attempt.errorMessage).toMatch(/first-week customer activity/);
  });
});
