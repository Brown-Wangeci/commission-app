import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostJobForm, REVIEW_CHOICES } from "@/components/client/PostJobForm";
import { ReviewSettingToggle } from "@/components/client/ReviewSettingToggle";
import { submitActivation } from "@/lib/activations/submit";
import { prisma } from "@/lib/db";
import { contestRefusal } from "@/lib/disputes/disputes";
import { authorisePayout } from "@/lib/payouts/authorise";
import { approveActivation } from "@/lib/review/actions";
import { openReasonLabel, whyHere } from "@/lib/review/copy";
import { reviewDetail } from "@/lib/review/detail";
import { REVIEW_SETTING_EFFECT } from "@/lib/review/effect";
import { listQueue } from "@/lib/review/queue";
import { reviewRequired, reviewSettingSchema, setClientReviewSetting } from "@/lib/review/requirement";
import { forceT7 } from "@/lib/scoring/force";
import { runDueScoringJobs } from "@/lib/scoring/runner";
import { addWeekOfActivity } from "./helpers/activity";
import { resetDatabase } from "./helpers/db";
import { createClient, createUser } from "./helpers/factories";
import { replyWith, startFakeScoring, type FakeScoring } from "./helpers/fake-scoring";
import { publishFundedJob, readyAssignment, submissionFor } from "./helpers/submission";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

type Band = "auto_release" | "review" | "reject";
type Settings = { account?: boolean; job?: boolean | null };

let fake: FakeScoring;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const afterHold = () => new Date(Date.now() + WEEK_MS + 60_000);
const serviceDown = () => ({ status: 503, body: {} });

beforeAll(async () => {
  fake = await startFakeScoring();
  process.env.SCORING_SERVICE_URL = fake.url;
  process.env.HOLD_WINDOW_SECONDS = "604800";
});
afterAll(() => fake.close());
beforeEach(async () => {
  await resetDatabase();
  fake.requests.length = 0;
});

async function setAccount(activationId: string, reviewAllSubmissions: boolean): Promise<void> {
  const { job } = await prisma.activation.findUniqueOrThrow({ where: { id: activationId }, include: { job: { include: { client: true } } } });
  await setClientReviewSetting({ clientId: job.clientId, actorId: job.client.userId, reviewAllSubmissions });
}

/** Submits one activation under the given settings; T0 replies with `band`. */
async function submitUnder(settings: Settings, band: Band = "auto_release", probability = 0.05) {
  const assignment = await readyAssignment({ job: { reviewAllSubmissions: settings.job ?? null } });
  if (settings.account) {
    const job = await prisma.job.findUniqueOrThrow({ where: { id: assignment.jobId }, include: { client: true } });
    await setClientReviewSetting({ clientId: job.clientId, actorId: job.client.userId, reviewAllSubmissions: true });
  }
  fake.setHandler(replyWith(band, probability));
  return submitActivation(submissionFor(assignment));
}

/** A held activation with a reported week, then scored at hold-close with `band`. */
async function holdClose(settings: Settings, band: Band, probability: number): Promise<string> {
  const { activationId } = await submitUnder(settings);
  await addWeekOfActivity(activationId);
  fake.setHandler(replyWith(band, probability));
  await runDueScoringJobs(afterHold());
  return activationId;
}

function load(id: string) {
  return prisma.activation.findUniqueOrThrow({
    where: { id },
    include: {
      decisions: { orderBy: { recordedAt: "asc" }, include: { reasons: true } },
      reviewItems: { orderBy: { openedAt: "asc" } },
      payout: true,
      commission: true,
      disbursement: true,
      dispute: true,
    },
  });
}

async function expectNothingPayable(id: string): Promise<void> {
  const activation = await load(id);
  expect(activation.payout).toBeNull();
  expect(activation.commission).toBeNull();
  expect(activation.disbursement).toBeNull();
  expect(await prisma.auditEvent.count({ where: { activationId: id, kind: "payout_authorised" } })).toBe(0);
}

describe("review setting at submission (T0)", () => {
  it("off: an auto_release at T0 is held and nothing is payable", async () => {
    const { activationId, state } = await submitUnder({});
    expect(state).toBe("held");
    await expectNothingPayable(activationId);
  });

  it("on: an auto_release at T0 is held, scored and stored, and never released", async () => {
    const { activationId, state } = await submitUnder({ account: true });
    expect(state).toBe("held");
    const activation = await load(activationId);
    expect(activation.decisions.map((d) => [d.mode, d.band])).toEqual([["t0", "auto_release"]]);
    expect(activation.decisions[0].reasons).toHaveLength(3);
    expect(activation.reviewItems).toHaveLength(0);
    expect(await prisma.scoringJob.count({ where: { activationId, mode: "t7", status: "pending" } })).toBe(1);
    await expectNothingPayable(activationId);
  });

  it("on: a review band at T0 is held, as when off", async () => {
    expect((await submitUnder({ account: true }, "review", 0.5)).state).toBe("held");
  });

  it("on: a reject at T0 is escalated with the same reason as when off", async () => {
    const { activationId, state } = await submitUnder({ account: true }, "reject", 0.91);
    expect(state).toBe("in_review");
    expect((await load(activationId)).reviewItems.map((item) => item.openReason)).toEqual(["t0_reject_escalation"]);
  });
});

describe("review setting at hold-close (T7)", () => {
  it("off: an auto_release is paid with no reviewer, as before", async () => {
    const activation = await load(await holdClose({}, "auto_release", 0.05));
    expect(activation.state).toBe("approved");
    expect(activation.payout).toMatchObject({ authorisedById: null });
    expect(activation.reviewItems).toHaveLength(0);
  });

  it("on: an auto_release goes to review as client_requires_review with the score and reasons stored", async () => {
    const id = await holdClose({ account: true }, "auto_release", 0.05);
    const activation = await load(id);
    expect(activation.state).toBe("in_review");
    expect(activation.reviewItems).toMatchObject([{ openReason: "client_requires_review", closedAt: null }]);
    expect(activation.decisions.map((d) => [d.mode, d.band])).toEqual([["t0", "auto_release"], ["t7", "auto_release"]]);
    expect(activation.decisions[1]).toMatchObject({ probability: 0.05, trigger: "hold_close" });
    expect(activation.decisions[1].reasons).toHaveLength(3);
    await expectNothingPayable(id);
    await runDueScoringJobs(new Date(Date.now() + 5 * WEEK_MS));
    expect((await load(id)).state).toBe("in_review");
    await expectNothingPayable(id);
  });

  it("on: a review band keeps the reason band_review", async () => {
    const activation = await load(await holdClose({ account: true }, "review", 0.5));
    expect(activation.state).toBe("in_review");
    expect(activation.reviewItems.map((item) => item.openReason)).toEqual(["band_review"]);
  });

  it("on: a reject is still refused automatically and can be contested", async () => {
    const id = await holdClose({ account: true }, "reject", 0.9);
    const activation = await load(id);
    expect(activation.state).toBe("refused");
    expect(activation.dispute).toMatchObject({ status: "open", refusedById: null });
    expect(activation.reviewItems).toHaveLength(0);
    await expectNothingPayable(id);
  });

  it("on: an administrator forcing the hold-close score on a held activation also sends it to review", async () => {
    const admin = await createUser("admin");
    const { activationId } = await submitUnder({ account: true });
    await addWeekOfActivity(activationId);
    expect(await forceT7(activationId, admin.id)).toBe("scored");
    expect((await load(activationId)).reviewItems.map((item) => item.openReason)).toEqual(["client_requires_review"]);
    await expectNothingPayable(activationId);
  });
});

describe("review setting when scoring fails", () => {
  it("on: a submission that cannot be scored at T0 behaves as when off, and a later score is advice only", async () => {
    const assignment = await readyAssignment({ job: { reviewAllSubmissions: true } });
    fake.setHandler(serviceDown);
    const { activationId } = await submitActivation(submissionFor(assignment));
    fake.setHandler(replyWith("auto_release", 0.05));
    await runDueScoringJobs(afterHold());
    const activation = await load(activationId);
    expect(activation.state).toBe("in_review");
    expect(activation.reviewItems.map((item) => item.openReason)).toEqual(["could_not_be_scored"]);
    expect(activation.decisions).toHaveLength(1);
    await expectNothingPayable(activationId);
  });

  it("on: a hold-close score that fails keeps the reason could_not_be_scored", async () => {
    const { activationId } = await submitUnder({ account: true });
    await addWeekOfActivity(activationId);
    fake.setHandler(serviceDown);
    await runDueScoringJobs(afterHold());
    const activation = await load(activationId);
    expect(activation.unscoredStage).toBe("t7");
    expect(activation.reviewItems.map((item) => item.openReason)).toEqual(["could_not_be_scored"]);
    await expectNothingPayable(activationId);
  });
});

describe("when the setting is read", () => {
  it("turned on while an activation is held: it goes to review", async () => {
    const { activationId } = await submitUnder({});
    await addWeekOfActivity(activationId);
    await setAccount(activationId, true);
    await runDueScoringJobs(afterHold());
    expect((await load(activationId)).reviewItems.map((item) => item.openReason)).toEqual(["client_requires_review"]);
    await expectNothingPayable(activationId);
  });

  it("turned off while an activation is held: it is released", async () => {
    const { activationId } = await submitUnder({ account: true });
    await addWeekOfActivity(activationId);
    await setAccount(activationId, false);
    await runDueScoringJobs(afterHold());
    expect((await load(activationId)).state).toBe("approved");
  });

  it("turned off after an activation reached review: it stays with the reviewer", async () => {
    const id = await holdClose({ account: true }, "auto_release", 0.05);
    await setAccount(id, false);
    await runDueScoringJobs(new Date(Date.now() + 5 * WEEK_MS));
    expect((await load(id)).state).toBe("in_review");
    await expectNothingPayable(id);
  });
});

describe("per-job override", () => {
  it("resolves to the job's choice where it has one, else the client's", () => {
    const cases: Array<[boolean | null, boolean, boolean]> = [
      [null, false, false], [null, true, true], [true, false, true], [true, true, true], [false, false, false], [false, true, false],
    ];
    for (const [job, account, expected] of cases) {
      expect(reviewRequired({ reviewAllSubmissions: job, client: { reviewAllSubmissions: account } })).toBe(expected);
    }
  });

  it("job on, account off: the auto_release goes to review", async () => {
    const id = await holdClose({ job: true }, "auto_release", 0.05);
    expect((await load(id)).reviewItems.map((item) => item.openReason)).toEqual(["client_requires_review"]);
    await expectNothingPayable(id);
  });

  it("job off, account on: the auto_release is paid", async () => {
    const activation = await load(await holdClose({ account: true, job: false }, "auto_release", 0.05));
    expect(activation.state).toBe("approved");
    expect(activation.payout).toMatchObject({ authorisedById: null });
  });

  it("stores the choice made at publication, none by default, and records a choice in the audit log", async () => {
    const plain = await publishFundedJob();
    const chosen = await publishFundedJob({ reviewAllSubmissions: true });
    const off = await publishFundedJob({ reviewAllSubmissions: false });
    expect([plain.job, chosen.job, off.job].map((job) => job.reviewAllSubmissions)).toEqual([null, true, false]);
    expect(plain.client.reviewAllSubmissions).toBe(false);
    const details = (await prisma.auditEvent.findMany({ where: { kind: "job_posted" }, orderBy: { id: "asc" } })).map((e) => e.detail ?? "");
    expect(details[0]).not.toContain("Reviewer required");
    expect(details[1]).toContain("Reviewer required before any payment: on for this job.");
    expect(details[2]).toContain("Reviewer required before any payment: off for this job.");
  });
});

describe("no payout without a reviewer while the setting is on", () => {
  it("refuses an authorisation with no reviewer and writes nothing", async () => {
    const { activationId } = await submitUnder({ account: true });
    const attempt = prisma.$transaction((tx) => authorisePayout(tx, { activationId, authorisedById: null, at: new Date() }));
    await expect(attempt).rejects.toThrow(/needs a reviewer/);
    await expectNothingPayable(activationId);
  });

  it("authorises the payout under the reviewer who approves", async () => {
    const reviewer = await createUser("admin");
    const id = await holdClose({ account: true }, "auto_release", 0.05);
    await approveActivation({ activationId: id, reviewerId: reviewer.id, reason: "Evidence checked." });
    const activation = await load(id);
    expect(activation.state).toBe("approved");
    expect(activation.payout).toMatchObject({ authorisedById: reviewer.id });
    expect(activation.commission).toMatchObject({ approvedById: reviewer.id });
    expect(activation.reviewItems).toMatchObject([{ openReason: "client_requires_review", action: "approved", reviewerId: reviewer.id }]);
  });

  it("leaves no payout without a reviewer across every band", async () => {
    const reviewer = await createUser("admin");
    await holdClose({ account: true }, "auto_release", 0.05);
    await holdClose({ account: true }, "review", 0.5);
    const refused = await holdClose({ account: true }, "reject", 0.9);
    expect(await prisma.payoutAuthorisation.count()).toBe(0);
    const { agentId } = await load(refused);
    await contestRefusal({ agentId, activationId: refused, note: "The customer is real." });
    await approveActivation({ activationId: refused, reviewerId: reviewer.id, reason: "Overturned on the evidence." });
    expect(await prisma.payoutAuthorisation.findMany()).toMatchObject([{ activationId: refused, authorisedById: reviewer.id }]);
  });
});

describe("changing the setting", () => {
  it("records one audit event per change, naming who made it, and none for a repeat", async () => {
    const client = await createClient();
    const other = await createClient();
    const change = (reviewAllSubmissions: boolean) => setClientReviewSetting({ clientId: client.id, actorId: client.userId, reviewAllSubmissions });
    expect(await change(false)).toEqual({ changed: false });
    expect(await change(true)).toEqual({ changed: true });
    expect(await change(true)).toEqual({ changed: false });
    expect(await change(false)).toEqual({ changed: true });
    const events = await prisma.auditEvent.findMany({ where: { kind: "review_setting_changed" }, orderBy: { id: "asc" } });
    expect(events.map((e) => [e.actorId, e.detail])).toEqual([
      [client.userId, `${client.name}: reviewer required before any payment turned on.`],
      [client.userId, `${client.name}: reviewer required before any payment turned off.`],
    ]);
    expect((await prisma.clientBusiness.findUniqueOrThrow({ where: { id: other.id } })).reviewAllSubmissions).toBe(false);
  });

  it("accepts only a true or false value", () => {
    expect(reviewSettingSchema.safeParse({ reviewAllSubmissions: true }).success).toBe(true);
    for (const body of [{}, { reviewAllSubmissions: "true" }, { reviewAllSubmissions: 1 }, { reviewAllSubmissions: null }]) {
      expect(reviewSettingSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe("what the reviewer sees", () => {
  it("labels the queue row, explains why it is there and keeps the score and reasons", async () => {
    const id = await holdClose({ account: true }, "auto_release", 0.05);
    const [row] = await listQueue(prisma, "waiting");
    expect(row).toMatchObject({ id, openReason: "client_requires_review", latest: { mode: "t7", band: "auto_release", probability: 0.05 } });
    expect(openReasonLabel(row.openReason)).toBe("Client requires review");
    const detail = await reviewDetail(prisma, id);
    expect(detail.latest?.reasons).toHaveLength(3);
    const why = whyHere(row.openReason, detail.latest, detail.unscoredStage);
    expect(why).toMatch(/^The client requires a reviewer before any payment on this job, so it was not released automatically\./);
    expect(why).toContain("at or below the auto-approve cut-off");
  });
});

describe("what the client sees", () => {
  it("shows the account toggle with its state and one sentence on the effect", () => {
    const on = renderToStaticMarkup(<ReviewSettingToggle enabled />);
    expect(on).toContain(REVIEW_SETTING_EFFECT);
    expect(on).toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
    expect(on).toContain("Currently on for your account.");
    expect(renderToStaticMarkup(<ReviewSettingToggle enabled={false} />)).not.toMatch(/<input[^>]*checked/);
    expect(REVIEW_SETTING_EFFECT.match(/\./g)).toHaveLength(1);
  });

  it("offers the job's choice on the post-a-job form, following the account by default", () => {
    const html = renderToStaticMarkup(<PostJobForm availableCents={0} defaultDeadline="2026-12-25" accountReviewSetting />);
    expect(html).toContain("Use my account setting (currently on)");
    expect(html).toContain("On for this job");
    expect(html).toContain("Off for this job");
    expect(html).toContain(REVIEW_SETTING_EFFECT);
    expect([REVIEW_CHOICES[""], REVIEW_CHOICES.on, REVIEW_CHOICES.off]).toEqual([null, true, false]);
  });
});
