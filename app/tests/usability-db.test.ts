import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { approveActivation } from "@/lib/review/actions";
import { attention } from "@/lib/review/dashboard";
import { noScoreReason, noScoreSentence, whyHere } from "@/lib/review/copy";
import { reviewDetail } from "@/lib/review/detail";
import { listQueue } from "@/lib/review/queue";
import { runDueScoringJobs } from "@/lib/scoring/runner";
import { resetDatabase } from "./helpers/db";
import { createUser } from "./helpers/factories";
import { replyWith, startFakeScoring, type FakeScoring } from "./helpers/fake-scoring";
import { publishFundedJob, submitReady } from "./helpers/submission";

/** The usability pass: the dashboard's attention block, and the wording for an activation with no score. */

let fake: FakeScoring;
const LATER = () => new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);

beforeAll(async () => {
  fake = await startFakeScoring(replyWith("reject", 0.88));
});
afterAll(() => fake.close());
beforeEach(async () => {
  await resetDatabase();
  fake.setHandler(replyWith("reject", 0.88));
  process.env.SCORING_SERVICE_URL = fake.url;
  process.env.SCORING_TIMEOUT_MS = "300";
  process.env.SCORING_IMMEDIATE_ATTEMPTS = "1";
  process.env.SCORING_IMMEDIATE_BACKOFF_MS = "5";
  process.env.HOLD_WINDOW_SECONDS = "604800";
});

describe("the dashboard's block of things that need a person", () => {
  it("is empty, and says so by its total, when nothing needs anyone", async () => {
    const result = await attention(prisma);
    expect(result.total).toBe(0);
    expect(result.items.map((item) => item.count)).toEqual([0, 0, 0, 0]);
  });

  it("counts submissions awaiting a decision, those that could not be scored, failed or unconfirmed payouts, and jobs without an agent", async () => {
    process.env.SCORING_SERVICE_URL = "http://127.0.0.1:9";
    await submitReady(); // service down: in review, could not be scored
    process.env.SCORING_SERVICE_URL = fake.url;
    const paid = (await submitReady()).activationId; // T0 reject: in review with a score
    await publishFundedJob(); // a job nobody has been assigned to

    const reviewer = await createUser("admin");
    await approveActivation({ activationId: paid, reviewerId: reviewer.id, reason: "Customer confirmed by phone" });
    const disbursement = await prisma.disbursement.findUniqueOrThrow({ where: { activationId: paid } });
    await prisma.disbursement.update({ where: { id: disbursement.id }, data: { status: "sending" } });
    await prisma.disbursement.update({ where: { id: disbursement.id }, data: { status: "unconfirmed" } });

    const result = await attention(prisma);
    const counts = Object.fromEntries(result.items.map((item) => [item.id, item.count]));
    expect(counts).toEqual({ decisions: 1, unscored: 1, payouts: 1, jobs: 1 });
    expect(result.total).toBe(4);
    expect(result.items.find((item) => item.id === "payouts")?.href).toBe("/admin/payouts");
    expect(result.items.find((item) => item.id === "jobs")?.href).toBe("/admin/jobs");
  });

  it("puts the items with something to do ahead of those with nothing", async () => {
    await publishFundedJob();
    const result = await attention(prisma);
    expect(result.items[0].id).toBe("jobs");
    expect(result.items.slice(1).every((item) => item.count === 0)).toBe(true);
  });
});

describe("saying why there is no score (item 6)", () => {
  it("says the first week of activity is missing, not that the model could not be reached", async () => {
    fake.setHandler(replyWith("review", 0.4)); // held at submission, so the hold-close score is due later
    const { activationId } = await submitReady();
    await runDueScoringJobs(LATER()); // hold closes with no first-week activity reported
    const row = (await listQueue(prisma, "waiting")).find((r) => r.id === activationId)!;
    expect(row.unscoredStage).toBe("t7");
    expect(row.lastFailure?.kind).toBe("missing_input");

    const reason = noScoreReason("t7", row.lastFailure);
    expect(reason).toMatch(/first week of activity/);
    expect(reason).not.toMatch(/could not be reached/);

    const detail = await reviewDetail(prisma, activationId);
    const sentence = whyHere(null, detail.latest, detail.unscoredStage, detail.health.lastFailure);
    expect(sentence).toBe(
      "No score: the hold-close model needs the customer's first week of activity, and none has been reported, so it was sent to a person instead of being released.",
    );
  });

  it("still says the model could not be reached when the scoring service is down", async () => {
    process.env.SCORING_SERVICE_URL = "http://127.0.0.1:9";
    const { activationId } = await submitReady();
    const row = (await listQueue(prisma, "waiting")).find((r) => r.id === activationId)!;
    expect(row.unscoredStage).toBe("t0");
    expect(row.lastFailure?.kind).toBe("unavailable");
    expect(noScoreSentence("t0", row.lastFailure)).toBe("No score: the model could not be reached at submission, so it was sent to a person instead of being released.");
  });
});
