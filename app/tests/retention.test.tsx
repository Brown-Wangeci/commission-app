import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EvidenceResponseForm } from "@/components/agent/EvidenceResponseForm";
import { respondToEvidenceRequest } from "@/lib/activations/agent-actions";
import { submitActivation } from "@/lib/activations/submit";
import { useChain } from "@/lib/anchoring/chain";
import { runDueAnchoring } from "@/lib/anchoring/queue";
import { verifyActivationAudit } from "@/lib/audit/verify";
import { prisma } from "@/lib/db";
import { readStored } from "@/lib/evidence/storage";
import { approveActivation, refuseActivation, requestEvidence } from "@/lib/review/actions";
import { anonymiseActivation, ANONYMISED, clearedPayload, coarsenDegrees, retentionCutoff, runRetention } from "@/lib/retention/anonymise";
import { AUDIT_TEXT_NOTICE } from "@/lib/retention/notice";
import { resetDatabase } from "./helpers/db";
import { FakeChain } from "./helpers/fake-chain";
import { createUser } from "./helpers/factories";
import { replyWith, startFakeScoring, type FakeScoring } from "./helpers/fake-scoring";
import { deliverPayment } from "./helpers/payout";
import { photoInput, readyAssignment, submissionFor, submitReady } from "./helpers/submission";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

const DAY = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 400;
const appDir = path.resolve(__dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(appDir, file), "utf8");

let fake: FakeScoring;
let chain: FakeChain;

beforeAll(async () => {
  fake = await startFakeScoring(replyWith("reject", 0.91));
  process.env.SCORING_SERVICE_URL = fake.url;
  process.env.HOLD_WINDOW_SECONDS = "604800";
});
afterAll(() => fake.close());
beforeEach(async () => {
  await resetDatabase();
  process.env.RETENTION_DAYS = String(RETENTION_DAYS);
  delete process.env.RETENTION_MAX_PER_RUN;
  chain = new FakeChain();
  useChain(chain);
});
afterEach(() => useChain());

/** `updatedAt` is set by Prisma, so a test that needs an old record writes the column directly. */
async function settledOn(activationId: string, at: Date): Promise<void> {
  await prisma.$executeRaw`UPDATE "Activation" SET "updatedAt" = ${at} WHERE id = ${activationId}`;
}

function load(activationId: string) {
  return prisma.activation.findUniqueOrThrow({
    where: { id: activationId },
    include: { evidence: { orderBy: { sequence: "asc" } }, reviewItems: true, evidenceRequests: true, dispute: true, decisions: { include: { reasons: true } }, commission: true, payout: true, disbursement: true },
  });
}

/** A job that asks for a photo and for free text of the client's own, as a real one does. */
const JOB_FIELDS = [
  { label: "Photos of the activation", type: "photo" as const, mandatory: true, help: null, format: { minCount: 1, maxCount: 12 } },
  { label: "Who was present", type: "text" as const, mandatory: true, help: null, format: { pattern: "any" as const, minLength: 2, maxLength: 200 } },
];

/**
 * A refused submission that went the long way round, so it carries every kind
 * of free text: the client's own evidence field, the agent's note to the
 * reviewer, a reviewer's evidence request, the agent's reply, the reviewer's
 * refusal reason and the dispute record that quotes it.
 */
async function refusedWithEveryNote(daysAgo: number): Promise<string> {
  const reviewer = await createUser("admin");
  const assignment = await readyAssignment({ job: { evidenceFields: JOB_FIELDS } });
  const { activationId } = await submitActivation(
    submissionFor(assignment, { values: { field_2: "Jane Mwangi was present", agentNote: "Call Jane on 0712345678." } }),
  );
  await requestEvidence({ activationId, reviewerId: reviewer.id, reason: "Send the SIM pack photo for Jane Mwangi, 0712345678." });
  const agentId = (await prisma.activation.findUniqueOrThrow({ where: { id: activationId } })).agentId;
  await respondToEvidenceRequest({ agentId, activationId, note: "Jane's pack is in the photo; her number is 0712345678.", photos: [photoInput("reply.png")] });
  await refuseActivation({ activationId, reviewerId: reviewer.id, reason: "Jane Mwangi says she never signed up." });
  await settledOn(activationId, new Date(Date.now() - daysAgo * DAY));
  return activationId;
}

/** An approved submission whose payout was made, so its payout numbers can be masked. */
async function approvedAndPaid(daysAgo: number): Promise<string> {
  const reviewer = await createUser("admin");
  const { activationId } = await submitReady();
  await approveActivation({ activationId, reviewerId: reviewer.id, reason: "Evidence checked." });
  await deliverPayment(activationId);
  await settledOn(activationId, new Date(Date.now() - daysAgo * DAY));
  return activationId;
}

describe("what the retention limit covers", () => {
  it("counts from the day the submission settled, and only settled submissions are eligible", async () => {
    const now = new Date("2027-01-01T00:00:00.000Z");
    expect(retentionCutoff(now, 400).toISOString()).toBe("2025-11-27T00:00:00.000Z");
    const old = await refusedWithEveryNote(RETENTION_DAYS + 5);
    const inFlight = (await submitReady()).activationId;
    await settledOn(inFlight, new Date(Date.now() - (RETENTION_DAYS + 5) * DAY));
    const summary = await runRetention();
    expect(summary).toMatchObject({ eligible: 1, anonymised: 1, failed: 0, deferred: 0, retentionDays: RETENTION_DAYS });
    expect((await load(old)).anonymisedAt).not.toBeNull();
    // Still with a reviewer, however old: nothing is removed while a decision is owed.
    expect((await load(inFlight)).anonymisedAt).toBeNull();
  });

  it("leaves a submission inside the limit completely untouched", async () => {
    const recent = await refusedWithEveryNote(RETENTION_DAYS - 5);
    const before = await load(recent);
    const summary = await runRetention();
    expect(summary).toMatchObject({ eligible: 0, anonymised: 0 });
    expect(await load(recent)).toEqual(before);
    expect(await prisma.auditEvent.count({ where: { kind: "retention_anonymised" } })).toBe(0);
  });

  it("waits for a payout that is not settled, and takes the submission once it is paid", async () => {
    const reviewer = await createUser("admin");
    const { activationId } = await submitReady();
    await approveActivation({ activationId, reviewerId: reviewer.id, reason: "Evidence checked." });
    await settledOn(activationId, new Date(Date.now() - (RETENTION_DAYS + 5) * DAY));
    expect(await runRetention()).toMatchObject({ eligible: 0, anonymised: 0 });

    await deliverPayment(activationId);
    expect((await load(activationId)).disbursement?.status).toBe("paid");
    await settledOn(activationId, new Date(Date.now() - (RETENTION_DAYS + 5) * DAY));
    expect(await runRetention()).toMatchObject({ eligible: 1, anonymised: 1 });
  });
});

describe("what anonymising a submission removes and keeps", () => {
  it("removes the identifiers, the free text and the photos, and coarsens the fix to about a kilometre", async () => {
    const id = await refusedWithEveryNote(RETENTION_DAYS + 5);
    const before = await load(id);
    expect(before.evidence.length).toBeGreaterThan(0);
    await expect(readStored(before.evidence[0].storagePath)).resolves.toBeInstanceOf(Buffer);

    const summary = await runRetention();
    expect(summary.evidenceFilesDeleted).toBe(before.evidence.length);
    const after = await load(id);

    expect(after.customerMsisdnMasked).toBe(ANONYMISED);
    expect(after.customerMsisdnHash).not.toBe(before.customerMsisdnHash);
    expect(after.customerMsisdnHash).toMatch(/^anonymised-[0-9a-f]{24}$/);
    expect(after.deviceId).not.toBe(before.deviceId);
    expect(after.agentNote).toBeNull();
    expect(after.gpsAccuracyM).toBeNull();
    expect(after.gpsLat).toBe(coarsenDegrees(before.gpsLat));
    expect(Math.abs(after.gpsLat - before.gpsLat)).toBeLessThan(0.005);
    expect(after.anonymisedAt).not.toBeNull();

    // Every photo's bytes are gone and the rows keep no place, time or file name.
    for (const item of after.evidence) {
      await expect(readStored(item.storagePath)).rejects.toMatchObject({ status: 404 });
      expect(item).toMatchObject({ fileName: ANONYMISED, gpsLat: null, gpsLon: null, gpsAccuracyM: null, locationSource: "none" });
    }

    // No name or number survives anywhere in the submission's own rows.
    const text = JSON.stringify([after.reviewItems, after.evidenceRequests, after.dispute, after.evidencePayload, after.agentNote]);
    expect(JSON.stringify(before.evidencePayload)).toMatch(/Jane Mwangi was present/);
    expect(after.evidencePayload).toEqual({ field_1: [1, 2], field_2: null });
    expect(text).not.toMatch(/Jane|Mwangi|0712345678/);
    expect(after.reviewItems.every((item) => item.reason === null)).toBe(true);
    expect(after.evidenceRequests.every((request) => request.message === ANONYMISED && request.responseNote === null)).toBe(true);
    expect(after.dispute).toMatchObject({ refusalReason: ANONYMISED, contestNote: null });
    expect((await prisma.notification.findMany({ where: { activationId: id } })).map((n) => n.message))
      .toEqual(Array(await prisma.notification.count({ where: { activationId: id } })).fill("This submission's record has been anonymised."));
  });

  it("keeps the feature vector, the score and the amounts, which retraining and the accounts need", async () => {
    const id = await approvedAndPaid(RETENTION_DAYS + 5);
    const before = await load(id);
    await runRetention();
    const after = await load(id);
    expect(after.decisions).toEqual(before.decisions);
    expect(after.decisions[0].featureVector).not.toBeNull();
    expect(after.decisions[0].reasons.length).toBeGreaterThan(0);
    expect(after.commission).toEqual(before.commission);
    expect(after.state).toBe(before.state);
    expect(after.reference).toBe(before.reference);
    expect(after.submittedAt).toEqual(before.submittedAt);
  });

  it("masks the agent's payout number on the settled payment, keeping the amount", async () => {
    const id = await approvedAndPaid(RETENTION_DAYS + 5);
    const before = await load(id);
    expect(before.payout?.payoutMsisdn).toBe("0712000000");
    await runRetention();
    const after = await load(id);
    expect(after.payout?.payoutMsisdn).toBe("07******000");
    expect(after.disbursement?.payoutMsisdn).toBe("07******000");
    expect(after.disbursement).toMatchObject({ status: "paid", amountCents: before.disbursement?.amountCents, receipt: before.disbursement?.receipt });
  });

  it("clears the typed values of the client's own evidence fields and keeps the photo numbering", () => {
    expect(clearedPayload({ field_1: [1, 2], field_2: "Jane Mwangi", field_3: 42 })).toEqual({ field_1: [1, 2], field_2: null, field_3: null });
    expect(clearedPayload(null)).toEqual({});
  });

  it("records the run as one audit event carrying counts and nothing else", async () => {
    await refusedWithEveryNote(RETENTION_DAYS + 5);
    await refusedWithEveryNote(RETENTION_DAYS + 6);
    await runRetention();
    const events = await prisma.auditEvent.findMany({ where: { kind: "retention_anonymised" } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ activationId: null, actorId: null, fromState: null, toState: null });
    // Four files each: two for the job's photo field, the proof of activation, and the photo sent with the agent's reply.
    expect(events[0].detail).toBe(`Retention run: 2 settled submission(s) anonymised after ${RETENTION_DAYS} day(s), 8 evidence file(s) deleted.`);
    expect(events[0].detail).not.toMatch(/Jane|Mwangi|0712345678|LF-/);
  });

  it("changes nothing when it runs again", async () => {
    const id = await refusedWithEveryNote(RETENTION_DAYS + 5);
    await runRetention();
    const after = await load(id);
    const events = await prisma.auditEvent.findMany({ orderBy: { id: "asc" } });

    expect(await runRetention()).toMatchObject({ eligible: 0, anonymised: 0, evidenceFilesDeleted: 0 });
    expect(await anonymiseActivation(id)).toBe(0);
    expect(await load(id)).toEqual(after);
    expect(await prisma.auditEvent.findMany({ orderBy: { id: "asc" } })).toEqual(events);
  });
});

describe("what the database itself refuses", () => {
  it("refuses any other change to the evidence payload, and refuses to un-anonymise a record", async () => {
    const id = await refusedWithEveryNote(RETENTION_DAYS + 5);
    await runRetention();
    await expect(prisma.activation.update({ where: { id }, data: { anonymisedAt: null } }))
      .rejects.toThrow(/anonymised once and cannot be un-anonymised/);
    await expect(prisma.activation.update({ where: { id }, data: { evidencePayload: { field_1: [1, 2], field_2: "Jane Mwangi" } } }))
      .rejects.toThrow(/evidence cannot change/);
  });

  it("refuses a payload cleared on its own, without the record being anonymised", async () => {
    const id = await refusedWithEveryNote(0);
    await expect(prisma.activation.update({ where: { id }, data: { evidencePayload: { field_1: [1, 2], field_2: null } } }))
      .rejects.toThrow(/evidence cannot change/);
  });

  it("refuses to change a paid payout number to anything but its masked form", async () => {
    const id = await approvedAndPaid(RETENTION_DAYS + 5);
    const disbursement = (await load(id)).disbursement!;
    await expect(prisma.disbursement.update({ where: { id: disbursement.id }, data: { payoutMsisdn: "0799888777" } }))
      .rejects.toThrow(/instruction cannot change/);
    await expect(prisma.disbursement.update({ where: { id: disbursement.id }, data: { payoutMsisdn: "07******000" } })).resolves.toBeTruthy();
  });
});

describe("the audit record is left exactly as it was (DR-09, NFR-11)", () => {
  it("verifies against the anchored root before and after, with every event and hash unchanged", async () => {
    const id = await approvedAndPaid(RETENTION_DAYS + 5);
    await runDueAnchoring(new Date());
    const anchor = await prisma.auditAnchor.findFirstOrThrow();
    expect(anchor.status).toBe("confirmed");

    const before = await verifyActivationAudit(prisma, id);
    expect(before.status).toBe("verified");
    const eventsBefore = await prisma.auditEvent.findMany({ orderBy: { id: "asc" }, include: { chain: true } });

    await runRetention();

    const after = await verifyActivationAudit(prisma, id);
    expect(after.status).toBe("verified");
    expect(after.events.map((event) => [event.eventId, event.storedHash, event.hashMatches, event.linkMatches, event.ok]))
      .toEqual(before.events.map((event) => [event.eventId, event.storedHash, event.hashMatches, event.linkMatches, event.ok]));
    // The anchored batch is untouched: same root, same transaction, still on chain.
    expect(await prisma.auditAnchor.findFirstOrThrow({ where: { id: anchor.id } })).toEqual(anchor);
    expect(after.events.every((event) => event.batch === null || event.batch.rootMatches)).toBe(true);

    // Not one audit row or link changed; the only new row is the retention event itself.
    const eventsAfter = await prisma.auditEvent.findMany({ orderBy: { id: "asc" }, include: { chain: true } });
    expect(eventsAfter.slice(0, eventsBefore.length)).toEqual(eventsBefore);
    expect(eventsAfter.slice(eventsBefore.length).map((event) => event.kind)).toEqual(["retention_anonymised"]);
  });

  it("still holds the free text that was typed before the limit, which is why DR-11 is only partly met", async () => {
    const id = await refusedWithEveryNote(RETENTION_DAYS + 5);
    await runRetention();
    const details = (await prisma.auditEvent.findMany({ where: { activationId: id } })).map((event) => event.detail ?? "");
    expect(details.join(" ")).toMatch(/Jane Mwangi/);
  });
});

describe("the notice on every form whose text enters the audit record", () => {
  it("warns against personal details and says the text cannot be deleted", () => {
    expect(AUDIT_TEXT_NOTICE).toMatch(/name, phone number, ID number/);
    expect(AUDIT_TEXT_NOTICE).toMatch(/cannot be deleted/);
  });

  it("is on the reviewer's decision and evidence-request form, and on the agent's contest, withdraw and reply forms", () => {
    // The two reviewer and contest forms open on a click, which this suite has
    // no DOM to make, so their use of the notice is read from the source.
    for (const file of ["src/components/review/PayoutPanel.tsx", "src/components/ReasonAction.tsx", "src/components/agent/EvidenceResponseForm.tsx"]) {
      expect(read(file)).toContain("{AUDIT_TEXT_NOTICE}");
      expect(read(file)).toContain('from "@/lib/retention/notice"');
    }
    expect(renderToStaticMarkup(<EvidenceResponseForm activationId="a1" />)).toContain(AUDIT_TEXT_NOTICE.split("customer")[1].slice(3));
  });
});
