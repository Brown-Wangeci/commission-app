import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { acceptAssignment, assignJob } from "@/lib/escrow/holds";
import { submitActivation, type SubmissionInput } from "@/lib/activations/submit";
import { configVersion, currentEvidenceConfig, evidenceConfigById, updateEvidenceConfig } from "@/lib/evidence/config";
import { validateEvidence, type FieldInput } from "@/lib/evidence/fields";
import { reviewDetail } from "@/lib/review/detail";
import { resetDatabase } from "./helpers/db";
import { replyWith, startFakeScoring, type FakeScoring } from "./helpers/fake-scoring";
import { createActivation, createAgent, createUser } from "./helpers/factories";
import { daysFromNow, photoInput, publishFundedJob, submissionFor } from "./helpers/submission";

let fake: FakeScoring;

beforeAll(async () => {
  fake = await startFakeScoring(replyWith("review", 0.4));
  process.env.SCORING_SERVICE_URL = fake.url;
});
afterAll(() => fake.close());
beforeEach(resetDatabase);

/** A job asking for a serial number, a choice, an optional count and two photo fields. */
const FIELDS: FieldInput[] = [
  { label: "SIM serial number", type: "text", mandatory: true, help: null, format: { pattern: "digits", minLength: 19, maxLength: 20 } },
  { label: "Customer type", type: "single_select", mandatory: true, help: null, format: { options: [{ value: "New", label: "New" }, { value: "Switching", label: "Switching" }] } },
  { label: "Bundles sold", type: "number", mandatory: false, help: null, format: { decimals: 0, min: 1, max: 5 } },
  { label: "Photo of the SIM pack", type: "photo", mandatory: true, help: null, format: { minCount: 1, maxCount: 2 } },
  { label: "Photo of the receipt", type: "photo", mandatory: false, help: null, format: { minCount: 0, maxCount: 1 } },
];

const STALL = { lat: -1.2834, lon: 36.8332, accuracy: 5 };

async function assignmentOn(fields: FieldInput[] = FIELDS) {
  const { client, job } = await publishFundedJob({ evidenceFields: fields, slots: 5 });
  const admin = await createUser("admin");
  const agent = await createAgent();
  const assignedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const assignment = await assignJob({ jobId: job.id, agentId: agent.id, assignedById: admin.id, at: assignedAt });
  await acceptAssignment({ assignmentId: assignment.id, agentId: agent.id, at: new Date(assignedAt.getTime() + 20 * 60 * 1000) });
  return { client, job, assignment: await prisma.assignment.findUniqueOrThrow({ where: { id: assignment.id } }) };
}

/** A valid submission for FIELDS: field_1..field_5 in order. */
function valid(assignment: Parameters<typeof submissionFor>[0], overrides: Partial<SubmissionInput> = {}): SubmissionInput {
  return submissionFor(assignment, {
    ...overrides,
    values: { field_1: "8925402123456789012", field_2: "Switching", field_3: "2", ...overrides.values },
    photos: { field_1: [], field_4: [photoInput("pack-1.png", STALL), photoInput("pack-2.png", null)], field_5: [photoInput("receipt.png", STALL)], ...overrides.photos },
  });
}

describe("submissions validated against their job's configuration (FR-12, issue #48)", () => {
  it("stores the job fields as a JSON payload, keyed by field, with photo fields listing their photos", async () => {
    const { assignment } = await assignmentOn();
    const { activationId } = await submitActivation(valid(assignment));
    const activation = await prisma.activation.findUniqueOrThrow({ where: { id: activationId }, include: { evidence: { orderBy: { sequence: "asc" } } } });
    expect(activation.evidencePayload).toEqual({ field_1: "8925402123456789012", field_2: "Switching", field_3: 2, field_4: [1, 2], field_5: [3] });
    expect(activation.evidence.map((e) => [e.sequence, e.kind, e.fieldKey])).toEqual([[1, "photo", "field_4"], [2, "photo", "field_4"], [3, "photo", "field_5"], [4, "proof", "proof"]]);
  });

  it("keeps each photo's own capture time and location, not the submission's (B2)", async () => {
    const { assignment } = await assignmentOn();
    const capturedAt = new Date(Date.now() - 15 * 60 * 1000);
    const pack = { ...photoInput("pack.png", { lat: -1.29, lon: 36.84, accuracy: 11 }), capturedAt };
    const { activationId } = await submitActivation(valid(assignment, { photos: { field_4: [pack] } }));
    const [item] = await prisma.evidenceItem.findMany({ where: { activationId, fieldKey: "field_4" } });
    expect(item).toMatchObject({ capturedAt, gpsLat: -1.29, gpsLon: 36.84, gpsAccuracyM: 11, locationSource: "device" });
    const activation = await prisma.activation.findUniqueOrThrow({ where: { id: activationId } });
    expect([activation.gpsLat, activation.gpsLon]).not.toEqual([-1.29, 36.84]);
  });

  it("rejects a submission that omits mandatory fields, naming them, and stores nothing", async () => {
    const { assignment } = await assignmentOn();
    const missing = submissionFor(assignment, { values: { field_3: "2" }, photos: { field_1: [] } });
    await expect(submitActivation(missing)).rejects.toMatchObject({
      status: 422,
      message: "Missing mandatory fields: SIM serial number, Customer type, Photo of the SIM pack.",
      details: [
        { path: "fields.field_1", message: "SIM serial number: This field is mandatory." },
        { path: "fields.field_2", message: "Customer type: This field is mandatory." },
        { path: "fields.field_4", message: "Photo of the SIM pack: This field is mandatory." },
      ],
    });
    expect(await prisma.activation.count()).toBe(0);
  });

  it("rejects a missing mandatory platform field the same way", async () => {
    const { assignment } = await assignmentOn();
    await expect(submitActivation(valid(assignment, { values: { customerMsisdn: "" } }))).rejects.toMatchObject({
      status: 422,
      message: "Missing mandatory field: Customer's phone number.",
    });
  });

  it("reports each format failure against its own field", async () => {
    const { assignment } = await assignmentOn();
    const wrong = valid(assignment, {
      values: { field_1: "89254021", field_2: "Returning", field_3: "9" },
      photos: { field_4: [photoInput("1.png"), photoInput("2.png"), photoInput("3.png")] },
    });
    await expect(submitActivation(wrong)).rejects.toMatchObject({
      status: 422,
      message: "4 fields are not in the expected format.",
      details: [
        { path: "fields.field_1", message: "SIM serial number: Enter at least 19 characters." },
        { path: "fields.field_2", message: "Customer type: Choose one of the listed options." },
        { path: "fields.field_3", message: "Bundles sold: Enter 5 or less." },
        { path: "fields.field_4", message: "Photo of the SIM pack: Attach at most 2 photos." },
      ],
    });
  });

  it("never stores a value under a key the configuration does not have", async () => {
    const { assignment } = await assignmentOn();
    const { activationId } = await submitActivation(valid(assignment, { values: { field_99: "not configured", score: "0.01" } }));
    const activation = await prisma.activation.findUniqueOrThrow({ where: { id: activationId } });
    expect(Object.keys(activation.evidencePayload as object).sort()).toEqual(["field_1", "field_2", "field_3", "field_4", "field_5"]);
  });
});

describe("configuration versions (A3, issue #46)", () => {
  it("validates a submission against the version in force when it was submitted, so an edit never invalidates it", async () => {
    const { client, job, assignment } = await assignmentOn();
    const { activationId } = await submitActivation(valid(assignment));
    const v1 = await currentEvidenceConfig(prisma, job.id);

    // The client makes the receipt mandatory, relabels the serial field and adds a mandatory stall number.
    const edited = v1.fields.map((f) => (f.key === "field_5" ? { ...f, mandatory: true, format: { minCount: 1, maxCount: 1 } } : f.key === "field_1" ? { ...f, label: "ICCID" } : f));
    const v2 = await updateEvidenceConfig({
      jobId: job.id, clientId: client.id, actorId: client.userId,
      fields: [...edited, { label: "Stall number", type: "text", mandatory: true, help: null, format: { pattern: "code", minLength: 2, maxLength: 6 } }],
    });
    expect([v1.version, v2.version]).toEqual([1, 2]);

    // The earlier submission still points at version 1 and still passes it; against version 2 it would fail.
    const stored = await prisma.activation.findUniqueOrThrow({ where: { id: activationId }, include: { evidenceConfig: true } });
    expect(stored.evidenceConfigId).toBe(v1.id);
    const payload = stored.evidencePayload as Record<string, unknown>;
    const asRaw = { values: Object.fromEntries(Object.entries(payload).filter(([, v]) => !Array.isArray(v)).map(([k, v]) => [k, String(v)])), photoCounts: { field_4: 2, field_5: 1 } };
    expect(validateEvidence(configVersion(stored.evidenceConfig).fields, asRaw, { today: daysFromNow(0) }).ok).toBe(true);
    expect(validateEvidence(v2.fields, asRaw, { today: daysFromNow(0) })).toMatchObject({ ok: false, missing: ["Stall number"] });

    // The review screen labels it with version 1's labels, and says the job has moved on.
    const detail = await reviewDetail(prisma, activationId);
    expect(detail.evidence).toMatchObject({ version: 1, currentVersion: 2 });
    expect(detail.evidence.fields.map((f) => f.label)).toEqual(["SIM serial number", "Customer type", "Bundles sold", "Photo of the SIM pack", "Photo of the receipt"]);

    // A new submission must meet version 2 and records it.
    const next = await assignJob({ jobId: job.id, agentId: assignment.agentId, assignedById: (await createUser("admin")).id, at: new Date(Date.now() - 60 * 60 * 1000) });
    await acceptAssignment({ assignmentId: next.id, agentId: assignment.agentId, at: new Date(Date.now() - 50 * 60 * 1000) });
    const accepted = await prisma.assignment.findUniqueOrThrow({ where: { id: next.id } });
    await expect(submitActivation(valid(accepted, { values: { customerMsisdn: "0722000111" } }))).rejects.toMatchObject({ status: 422, message: "Missing mandatory field: Stall number." });
    const second = await submitActivation(valid(accepted, { values: { customerMsisdn: "0722000111", field_6: "B-7" } }));
    expect((await prisma.activation.findUniqueOrThrow({ where: { id: second.activationId } })).evidenceConfigId).toBe(v2.id);
  });

  it("refuses a form rendered from a version that is no longer current, so the agent reloads it", async () => {
    const { client, job, assignment } = await assignmentOn();
    const v1 = await currentEvidenceConfig(prisma, job.id);
    await updateEvidenceConfig({ jobId: job.id, clientId: client.id, actorId: client.userId, fields: v1.fields });
    await expect(submitActivation(valid(assignment, { evidenceConfigId: v1.id }))).rejects.toMatchObject({ status: 409 });
  });

  it("keeps versions and submitted evidence fixed in the database", async () => {
    const { job, assignment } = await assignmentOn();
    const { activationId } = await submitActivation(valid(assignment));
    const v1 = await currentEvidenceConfig(prisma, job.id);
    await expect(prisma.evidenceConfig.update({ where: { id: v1.id }, data: { fields: [] } })).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`DELETE FROM "EvidenceConfig" WHERE id = ${v1.id}`).rejects.toThrow(/append-only/);
    await expect(prisma.activation.update({ where: { id: activationId }, data: { evidencePayload: { field_1: "changed" } } })).rejects.toThrow(/cannot change/);
  });

  it("will not link a submission to another job's configuration", async () => {
    const { assignment } = await assignmentOn();
    const other = await assignmentOn();
    const foreign = await currentEvidenceConfig(prisma, other.job.id);
    await expect(createActivation(assignment, { evidenceConfigId: foreign.id })).rejects.toThrow(/Activation_evidenceConfigId_jobId_fkey|Foreign key constraint/);
  });

  it("refuses edits from another client and on a closed job", async () => {
    const { client, job } = await assignmentOn();
    const stranger = await publishFundedJob();
    await expect(updateEvidenceConfig({ jobId: job.id, clientId: stranger.client.id, actorId: stranger.client.userId, fields: [] })).rejects.toMatchObject({ status: 404 });
    await prisma.job.update({ where: { id: job.id }, data: { status: "closed", closedAt: new Date() } });
    await expect(updateEvidenceConfig({ jobId: job.id, clientId: client.id, actorId: client.userId, fields: [] })).rejects.toMatchObject({ status: 409 });
  });
});

describe("what every submission retains (DR-07, issue #46)", () => {
  it("keeps the capture timestamp, the device location and the configuration version, on the record itself", async () => {
    const { job, assignment } = await assignmentOn();
    const submittedAt = new Date(Date.now() - 5 * 60 * 1000);
    const { activationId } = await submitActivation(valid(assignment, { submittedAt, gpsLat: -1.2836, gpsLon: 36.834, gpsAccuracyM: 7 }));
    const stored = await prisma.activation.findUniqueOrThrow({ where: { id: activationId } });
    const config = await evidenceConfigById(prisma, stored.evidenceConfigId);
    expect(stored).toMatchObject({ submittedAt, gpsLat: -1.2836, gpsLon: 36.834, gpsAccuracyM: 7 });
    expect(config).toMatchObject({ jobId: job.id, version: 1 });
    const columns = await prisma.$queryRaw<{ column_name: string; is_nullable: string }[]>`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'Activation' AND column_name IN ('submittedAt', 'gpsLat', 'gpsLon', 'evidenceConfigId', 'evidencePayload')`;
    expect(columns.map((c) => c.is_nullable)).toEqual(["NO", "NO", "NO", "NO", "NO"]);
  });
});
