import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requiredRole } from "@/lib/auth/policy";
import { prisma } from "@/lib/db";
import { contestRefusal } from "@/lib/disputes/disputes";
import { collectReviewLabels, exportReviewLabels, LABEL_FOR, ROW_FIELDS, serialiseRows, versionFor } from "@/lib/labels/export";
import { approveActivation, refuseActivation, requestEvidence } from "@/lib/review/actions";
import { respondToEvidenceRequest } from "@/lib/activations/agent-actions";
import { recordDecision } from "@/lib/scoring/decisions";
import { resetDatabase } from "./helpers/db";
import { createUser } from "./helpers/factories";
import { replyWith, startFakeScoring, type FakeScoring } from "./helpers/fake-scoring";
import { fakeResponse } from "./helpers/responses";
import { photoInput, readyAssignment, submissionFor, submitReady } from "./helpers/submission";
import { submitActivation } from "@/lib/activations/submit";

let fake: FakeScoring;

beforeAll(async () => {
  fake = await startFakeScoring(replyWith("reject", 0.91));
  process.env.SCORING_SERVICE_URL = fake.url;
  process.env.HOLD_WINDOW_SECONDS = "604800";
});
afterAll(() => fake.close());
beforeEach(async () => {
  await resetDatabase();
  fake.setHandler(replyWith("reject", 0.91));
});

/** A submission escalated at T0, so it is with a reviewer and has one T0 decision. */
async function escalated(values: Record<string, string> = {}): Promise<string> {
  const { activationId, state } = await submitReady({ values });
  expect(state).toBe("in_review");
  return activationId;
}

const rowsOf = () => collectReviewLabels(prisma).then((result) => result.rows);

describe("which submissions become labelled records", () => {
  it("exports one row per reviewed submission, with the human decision as the label", async () => {
    const reviewer = await createUser("admin");
    const approved = await escalated();
    const refused = await escalated({ customerMsisdn: "0799111222" });
    await approveActivation({ activationId: approved, reviewerId: reviewer.id, reason: "Evidence checked." });
    await refuseActivation({ activationId: refused, reviewerId: reviewer.id, reason: "The customer denies signing up." });

    const rows = await rowsOf();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.decision, row.label])).toEqual([["approved", 0], ["refused", 1]]);
    expect(LABEL_FOR).toEqual({ approved: 0, refused: 1 });
    expect(rows.every((row) => row.reviewer_role === "admin")).toBe(true);
    expect(rows.every((row) => row.open_reason === "t0_reject_escalation")).toBe(true);
  });

  it("exports nothing for a submission no person has decided", async () => {
    // Held after an auto_release at T0: scored, never seen by a reviewer.
    fake.setHandler(replyWith("auto_release", 0.05));
    expect((await submitReady()).state).toBe("held");
    // Waiting in the queue: a reviewer has it, but has not decided.
    fake.setHandler(replyWith("reject", 0.91));
    await escalated({ customerMsisdn: "0799111222" });
    expect(await rowsOf()).toEqual([]);
  });

  it("exports nothing for an agent's withdrawal or a reviewer asking for evidence, which are not decisions on the evidence", async () => {
    const reviewer = await createUser("admin");
    const asked = await escalated();
    await requestEvidence({ activationId: asked, reviewerId: reviewer.id, reason: "Send the SIM pack photo." });
    expect(await rowsOf()).toEqual([]);

    const agentId = (await prisma.activation.findUniqueOrThrow({ where: { id: asked } })).agentId;
    await respondToEvidenceRequest({ agentId, activationId: asked, note: "Attached.", photos: [photoInput("reply.png")] });
    expect(await rowsOf()).toEqual([]);

    await approveActivation({ activationId: asked, reviewerId: reviewer.id, reason: "The photo answers it." });
    expect((await rowsOf()).map((row) => [row.decision, row.open_reason])).toEqual([["approved", "evidence_returned"]]);
  });

  it("keeps only the final decision when a refusal is contested and overturned", async () => {
    const reviewer = await createUser("admin");
    const id = await escalated();
    await refuseActivation({ activationId: id, reviewerId: reviewer.id, reason: "No proof of activation." });
    expect((await rowsOf()).map((row) => row.label)).toEqual([1]);

    const agentId = (await prisma.activation.findUniqueOrThrow({ where: { id } })).agentId;
    await contestRefusal({ agentId, activationId: id, note: "The customer was there." });
    await approveActivation({ activationId: id, reviewerId: reviewer.id, reason: "Overturned on the evidence." });

    const rows = await rowsOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: "approved", label: 0, open_reason: "dispute" });
  });

  it("counts a reviewed submission whose decision stored no feature vector as skipped, not as a label", async () => {
    const reviewer = await createUser("admin");
    const id = await escalated();
    await approveActivation({ activationId: id, reviewerId: reviewer.id, reason: "Evidence checked." });
    // Decisions are append-only, so the vector is removed with a direct write, as an old row would have it.
    await prisma.$executeRaw`ALTER TABLE "ScoringDecision" DISABLE TRIGGER "ScoringDecision_append_only"`;
    await prisma.$executeRaw`UPDATE "ScoringDecision" SET "featureVector" = NULL WHERE "activationId" = ${id}`;
    await prisma.$executeRaw`ALTER TABLE "ScoringDecision" ENABLE TRIGGER "ScoringDecision_append_only"`;

    const { rows, skipped } = await collectReviewLabels(prisma);
    expect(rows).toEqual([]);
    expect(skipped).toEqual({ noFeatureVector: 1, noDecision: 0 });
  });
});

describe("what each row carries", () => {
  it("takes the feature vector and the score from the decision the reviewer saw, not a later one", async () => {
    const reviewer = await createUser("admin");
    const activationId = await escalated();
    await approveActivation({ activationId, reviewerId: reviewer.id, reason: "Evidence checked." });
    // A retry's score, recorded after the decision, is advice only and must not become the row.
    await recordDecision(prisma, activationId, fakeResponse({ activation_id: activationId, mode: "t7", calibrated_probability: 0.02, band: "auto_release" }), "retry");
    expect(await prisma.scoringDecision.count({ where: { activationId } })).toBe(2);

    const [row] = await rowsOf();
    expect(row.mode).toBe("t0");
    expect(row.model_probability).toBe(0.91);
    expect(Object.keys(row.features)).toEqual(Object.keys(row.features).slice().sort());
    expect(row.features.customer_active_days_7d).toBeUndefined();
  });

  it("groups an agent's rows together without naming the agent", async () => {
    const reviewer = await createUser("admin");
    const first = await readyAssignment();
    const { activationId: one } = await submitActivation(submissionFor(first));
    const second = await readyAssignment({ agentId: first.agentId });
    const { activationId: two } = await submitActivation(submissionFor(second, { values: { customerMsisdn: "0799111222" } }));
    const other = await escalated({ customerMsisdn: "0788333444" });
    for (const id of [one, two, other]) {
      await approveActivation({ activationId: id, reviewerId: reviewer.id, reason: "Evidence checked." });
    }
    const rows = await rowsOf();
    expect(rows).toHaveLength(3);
    expect(rows[0].agent_group).toBe(rows[1].agent_group);
    expect(rows[2].agent_group).not.toBe(rows[0].agent_group);
    expect(new Set(rows.map((row) => row.agent_group))).toEqual(new Set([1, 2]));
  });

  it("carries no personal data: none of what the database holds about these people appears in the bytes", async () => {
    const reviewer = await createUser("admin", "Amina Otieno");
    const id = await escalated({ customerMsisdn: "0799111222" });
    await refuseActivation({ activationId: id, reviewerId: reviewer.id, reason: "Jane Mwangi denies signing up; her number is 0799111222." });

    const activation = await prisma.activation.findUniqueOrThrow({
      where: { id },
      include: { agent: { include: { user: true } }, job: { include: { client: true } }, assignment: true, reviewItems: true },
    });
    const { rows } = await collectReviewLabels(prisma);
    const bytes = serialiseRows(rows);
    expect(rows).toHaveLength(1);

    const personal = [
      activation.id, activation.reference, activation.agentId, activation.assignmentId, activation.jobId,
      activation.customerMsisdnHash, activation.customerMsisdnMasked, activation.deviceId, activation.ipRegion,
      activation.agent.payoutMsisdn, activation.agent.user.name, activation.agent.user.email, activation.agent.homeAreaName,
      activation.job.title, activation.job.client.name, reviewer.id, reviewer.name, reviewer.email,
      activation.reviewItems[0].reason ?? "", "0799111222", "Jane Mwangi",
      String(activation.gpsLat), String(activation.gpsLon),
    ];
    for (const value of personal) {
      expect(value.length, "a test value must not be empty, or it matches everything").toBeGreaterThan(0);
      expect(bytes, `exported bytes must not contain ${value}`).not.toContain(value);
    }
    // Only the agreed fields, and every feature value a finite number.
    expect(Object.keys(JSON.parse(bytes.trim()))).toEqual([...ROW_FIELDS]);
    expect(Object.values(rows[0].features).every((value) => Number.isFinite(value))).toBe(true);
  });
});

describe("the manifest", () => {
  it("counts the rows, dates them, names the features and hashes the exact bytes", async () => {
    const reviewer = await createUser("admin");
    const approved = await escalated();
    const refused = await escalated({ customerMsisdn: "0799111222" });
    const at = new Date("2027-01-02T03:04:05.678Z");
    await approveActivation({ activationId: approved, reviewerId: reviewer.id, reason: "Evidence checked.", at: new Date("2026-12-01T08:00:00.000Z") });
    await refuseActivation({ activationId: refused, reviewerId: reviewer.id, reason: "No proof of activation.", at: new Date("2026-12-09T09:30:00.000Z") });

    const { manifest, rows } = await exportReviewLabels(prisma, { at });
    expect(manifest).toMatchObject({
      dataset: "ledgerfield-review-labels",
      version: "review-labels-20270102T030405Z",
      exportedAt: at.toISOString(),
      rows: 2,
      labels: { approved: 1, refused: 1 },
      byMode: { t0: 2 },
      byModelVersion: { "t0_none-isotonic-v1": 2 },
      agentGroups: 2,
      skipped: { noFeatureVector: 0, noDecision: 0 },
      labelMeaning: { approved: 0, refused: 1 },
      containsPersonalData: false,
    });
    expect(manifest.decisionRange).toEqual({ first: "2026-12-01T08:00:00.000Z", last: "2026-12-09T09:30:00.000Z" });
    expect(manifest.featureNames.t0).toEqual(Object.keys(rows[0].features).sort());
    expect(manifest.sha256).toBe(createHash("sha256").update(serialiseRows(rows), "utf8").digest("hex"));
    expect(manifest.fields).toEqual([...ROW_FIELDS]);
  });

  it("is a valid, empty export when nobody has reviewed anything", async () => {
    const { manifest, rows } = await exportReviewLabels(prisma);
    expect(rows).toEqual([]);
    expect(serialiseRows(rows)).toBe("");
    expect(manifest).toMatchObject({ rows: 0, labels: { approved: 0, refused: 0 }, agentGroups: 0, decisionRange: { first: null, last: null } });
    expect(manifest.sha256).toBe(createHash("sha256").update("", "utf8").digest("hex"));
  });

  it("writes the same bytes and the same hash every time, so the version can be checked", async () => {
    const reviewer = await createUser("admin");
    const id = await escalated();
    await approveActivation({ activationId: id, reviewerId: reviewer.id, reason: "Evidence checked." });
    const first = await exportReviewLabels(prisma, { version: "fixed" });
    const second = await exportReviewLabels(prisma, { version: "fixed" });
    expect(serialiseRows(second.rows)).toBe(serialiseRows(first.rows));
    expect(second.manifest.sha256).toBe(first.manifest.sha256);
  });

  it("names the version after the moment it was taken", () => {
    expect(versionFor(new Date("2026-11-25T12:34:56.789Z"))).toBe("review-labels-20261125T123456Z");
  });
});

describe("who may export", () => {
  it("is an administrator route, and the handler checks the role itself", () => {
    expect(requiredRole("/api/admin/labels/export")).toBe("admin");
    expect(requiredRole("/api/client/jobs")).not.toBe("admin");
  });
});
