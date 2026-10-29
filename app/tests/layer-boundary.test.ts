import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { acceptAssignment, assignJob } from "@/lib/escrow/holds";
import { submitActivation } from "@/lib/activations/submit";
import type { FieldInput } from "@/lib/evidence/fields";
import { ACTIVATION_EVENT_KEYS, assertFixedShape, buildScoreRequest, PayloadError } from "@/lib/scoring/payload";
import { runDueScoringJobs } from "@/lib/scoring/runner";
import type { ScoreRequestPayload } from "@/lib/scoring/contract";
import { addWeekOfActivity } from "./helpers/activity";
import { resetDatabase } from "./helpers/db";
import { replyWith, startFakeScoring, type FakeScoring } from "./helpers/fake-scoring";
import { createAgent, createUser } from "./helpers/factories";
import { photoInput, publishFundedJob, submissionFor } from "./helpers/submission";

/**
 * Issue #49, the two-layer design: a client's evidence fields are layer one
 * (validated against the job's template) and never reach layer two (the fraud
 * model), which takes only the fixed behavioural features. The model sees an
 * activation only through the /score request, so the test is on that request:
 * every value a client-defined field holds is a sentinel that must appear
 * nowhere in any request the app sends, at submission (T0) or at hold-close
 * (T7), for the activation itself or as history for a later one.
 */
let fake: FakeScoring;

beforeAll(async () => {
  fake = await startFakeScoring(replyWith("auto_release", 0.05));
  process.env.SCORING_SERVICE_URL = fake.url;
});
afterAll(() => fake.close());
beforeEach(async () => {
  await resetDatabase();
  fake.requests.length = 0;
  fake.setHandler(replyWith("auto_release", 0.05));
});

const FIELDS: FieldInput[] = [
  { label: "Free text", type: "text", mandatory: true, help: null, format: { pattern: "any", minLength: 1, maxLength: 200 } },
  { label: "A number", type: "number", mandatory: true, help: null, format: { decimals: 2, min: null, max: null } },
  { label: "A date", type: "date", mandatory: true, help: null, format: { allowFuture: true } },
  { label: "A choice", type: "single_select", mandatory: true, help: null, format: { options: [{ value: "SENTINEL-OPTION-3c1d", label: "SENTINEL-OPTION-3c1d" }, { value: "Other", label: "Other" }] } },
  { label: "A phone", type: "phone", mandatory: true, help: null, format: { country: "KE" } },
  { label: "A photo", type: "photo", mandatory: true, help: null, format: { minCount: 1, maxCount: 2 } },
];

/** Values chosen to be unmistakable anywhere they might surface. */
const SENTINELS = {
  field_1: "SENTINEL-TEXT-7f3a",
  field_2: "424242.17",
  field_3: "2011-11-11",
  field_4: "SENTINEL-OPTION-3c1d",
  field_5: "0799864213",
};
const NEEDLES = ["SENTINEL", "424242", "2011-11-11", "0799864213", "799864213", "field_", "evidence", "Free text", "A photo"];

async function submitWithSentinels(agentId?: string) {
  const { job } = await publishFundedJob({ evidenceFields: FIELDS, slots: 4 });
  const admin = await createUser("admin");
  const agent = agentId ?? (await createAgent()).id;
  const assignedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const assignment = await assignJob({ jobId: job.id, agentId: agent, assignedById: admin.id, at: assignedAt });
  await acceptAssignment({ assignmentId: assignment.id, agentId: agent, at: new Date(assignedAt.getTime() + 20 * 60 * 1000) });
  const accepted = await prisma.assignment.findUniqueOrThrow({ where: { id: assignment.id } });
  return submitActivation(submissionFor(accepted, { values: { ...SENTINELS }, photos: { field_6: [photoInput("sentinel-photo.png")] } }));
}

function leaks(request: ScoreRequestPayload): string[] {
  const text = JSON.stringify(request);
  return NEEDLES.filter((needle) => text.includes(needle));
}

describe("client-defined evidence never reaches the fraud model (issue #49)", () => {
  it("stores the client's values, so the sentinels are really there to leak", async () => {
    const { activationId } = await submitWithSentinels();
    const activation = await prisma.activation.findUniqueOrThrow({ where: { id: activationId } });
    expect(activation.evidencePayload).toMatchObject({ field_1: "SENTINEL-TEXT-7f3a", field_2: 424242.17, field_4: "SENTINEL-OPTION-3c1d", field_5: "0799864213" });
  });

  it("sends none of them in the submission-time (T0) request", async () => {
    await submitWithSentinels();
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].mode).toBe("t0");
    expect(leaks(fake.requests[0])).toEqual([]);
  });

  it("sends none of them in the hold-close (T7) request", async () => {
    fake.setHandler(replyWith("review", 0.4));
    const { activationId } = await submitWithSentinels();
    await addWeekOfActivity(activationId);
    await runDueScoringJobs(new Date(Date.now() + 8 * 24 * 60 * 60 * 1000));
    const t7 = fake.requests.find((request) => request.mode === "t7");
    expect(t7).toBeDefined();
    expect(leaks(t7!)).toEqual([]);
  });

  it("sends none of them when the activation travels as history for a later one", async () => {
    const first = await submitWithSentinels();
    const agentId = (await prisma.activation.findUniqueOrThrow({ where: { id: first.activationId } })).agentId;
    await submitWithSentinels(agentId);
    const later = fake.requests.at(-1)!;
    expect(later.recent_activations.map((a) => a.activation_id)).toContain(first.activationId);
    expect(leaks(later)).toEqual([]);
  });

  it("builds exactly the data dictionary's fields for every activation event, nothing more", async () => {
    const { activationId } = await submitWithSentinels();
    const request = await buildScoreRequest(prisma, activationId, "t0");
    expect(Object.keys(request).sort()).toEqual(["activation", "agents", "downstream_activity", "mode", "payout_calendar", "recent_activations"]);
    expect(Object.keys(request.activation).sort()).toEqual([...ACTIVATION_EVENT_KEYS].sort());
    expect(ACTIVATION_EVENT_KEYS).toHaveLength(20);
  });

  it("refuses to send a request carrying anything outside the contract", async () => {
    const { activationId } = await submitWithSentinels();
    const request = await buildScoreRequest(prisma, activationId, "t0");
    const smuggled = { ...request, activation: { ...request.activation, evidence_payload: SENTINELS } } as unknown as ScoreRequestPayload;
    expect(() => assertFixedShape(smuggled)).toThrow(PayloadError);
    const extraTop = { ...request, evidence: SENTINELS } as unknown as ScoreRequestPayload;
    expect(() => assertFixedShape(extraTop)).toThrow(PayloadError);
  });

  it("gives the model the same request whatever the client's fields say", async () => {
    const { activationId } = await submitWithSentinels();
    const before = await buildScoreRequest(prisma, activationId, "t0");
    // Rewrite the stored evidence directly (bypassing the trigger that forbids it) and build the request again.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`ALTER TABLE "Activation" DISABLE TRIGGER "Activation_evidence_fixed"`);
      await tx.$executeRaw`UPDATE "Activation" SET "evidencePayload" = '{"field_1": "something else entirely", "field_2": 1}'::jsonb WHERE id = ${activationId}`;
      await tx.$executeRawUnsafe(`ALTER TABLE "Activation" ENABLE TRIGGER "Activation_evidence_fixed"`);
    });
    const after = await buildScoreRequest(prisma, activationId, "t0");
    expect(after).toEqual(before);
  });
});
