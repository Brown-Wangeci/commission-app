import type { Assignment, ClientBusiness, Job } from "@prisma/client";
import { prisma } from "@/lib/db";
import { acceptAssignment, assignJob } from "@/lib/escrow/holds";
import { fundEscrow } from "@/lib/escrow/client";
import { createJob, type JobInput } from "@/lib/jobs/jobs";
import { maxLiability } from "@/lib/money/commission";
import { submitActivation, type PhotoInput, type SubmissionInput, type SubmissionResult } from "@/lib/activations/submit";
import { evidenceConfigInputSchema, nairobiDate, type FieldInput } from "@/lib/evidence/fields";
import { createAgent, createClient, createUser, TEST_EVIDENCE_FIELDS, TEST_TERMS } from "./factories";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const DAY_MS = 24 * 60 * 60 * 1000;

export function photo(name = "photo.png"): File {
  return new File([PNG_BYTES], name, { type: "image/png" });
}

/** A photo as the device stamps it: its own capture time and, when known, its own place. */
export function photoInput(name: string, at: { lat: number; lon: number; accuracy: number } | null = { lat: -1.2835, lon: 36.8331, accuracy: 6 }): PhotoInput {
  return {
    file: photo(name),
    capturedAt: new Date(),
    gpsLat: at?.lat ?? null,
    gpsLon: at?.lon ?? null,
    gpsAccuracyM: at?.accuracy ?? null,
    locationSource: at ? "device" : "none",
  };
}

/** A date n days from now as the agent types it (YYYY-MM-DD in Kenya). */
export function daysFromNow(days: number): string {
  return nairobiDate(new Date(Date.now() + days * DAY_MS));
}

/**
 * A valid job as a client would post it: KSh 300.00 per approved submission,
 * 10 slots, in the same area as the factory job (submissionFor's GPS fix is
 * inside it).
 */
type JobOverrides = Partial<Omit<JobInput, "evidenceFields">> & { evidenceFields?: FieldInput[] };

export function jobInput(overrides: JobOverrides = {}): JobInput {
  const { evidenceFields, ...rest } = overrides;
  return {
    title: "SIM registration drive, Gikomba Market",
    description: "Sign up new customers in person.",
    areaName: "Gikomba market",
    areaLat: -1.2833,
    areaLon: 36.8333,
    areaRadiusM: 1500,
    ...TEST_TERMS,
    slots: 10,
    initialDepositCents: 0,
    deadline: daysFromNow(60),
    ...rest,
    // Parsed as the API parses it, so tests may write fields as a client sends them.
    evidenceFields: evidenceConfigInputSchema.parse(evidenceFields ?? TEST_EVIDENCE_FIELDS.map(({ key: _key, ...field }) => field)),
  };
}

/**
 * A job published through the real code: the client deposits exactly the
 * job's maximum liability (plus any extra), then publishes it.
 */
export async function publishFundedJob(
  overrides: JobOverrides = {},
  options: { client?: ClientBusiness; extraDepositCents?: number } = {},
): Promise<{ client: ClientBusiness; job: Job }> {
  const client = options.client ?? (await createClient());
  const input = jobInput(overrides);
  const liability = maxLiability(input, input.slots).amountCents;
  await fundEscrow({ clientId: client.id, amountCents: liability + (options.extraDepositCents ?? 0), actorId: client.userId });
  const job = await createJob({ clientId: client.id, actorId: client.userId, job: input });
  return { client, job };
}

/** A funded job, assigned to an agent who has accepted it. */
export async function readyAssignment(options: { agentId?: string; assignedAt?: Date } = {}): Promise<Assignment> {
  const { job } = await publishFundedJob({ slots: 20 });
  const admin = await createUser("admin");
  const agentId = options.agentId ?? (await createAgent()).id;
  const assignedAt = options.assignedAt ?? new Date(Date.now() - 3 * 60 * 60 * 1000);
  const assignment = await assignJob({ jobId: job.id, agentId, assignedById: admin.id, at: assignedAt });
  await acceptAssignment({ assignmentId: assignment.id, agentId, at: new Date(assignedAt.getTime() + 20 * 60 * 1000) });
  return prisma.assignment.findUniqueOrThrow({ where: { id: assignment.id } });
}

/**
 * A valid submission for the test job's evidence fields (one mandatory photo
 * field, field_1). `values` and `photos` in the overrides are merged into the
 * defaults, field by field.
 */
export function submissionFor(assignment: Assignment, overrides: Partial<SubmissionInput> = {}): SubmissionInput {
  const values = { customerMsisdn: "0711222333", simRegisteredAt: daysFromNow(-20), activationMethod: "qr_scan", ...overrides.values };
  const photos = { field_1: [photoInput("a.png"), photoInput("b.png", null)], proof: [photoInput("proof.png", null)], ...overrides.photos };
  return {
    agentId: assignment.agentId,
    assignmentId: assignment.id,
    gpsLat: -1.2835,
    gpsLon: 36.8331,
    gpsAccuracyM: 8,
    device: { deviceId: "device-test-1", deviceOs: "android", appVersion: "3.4.0", networkType: "cellular", ipRegion: null },
    ...overrides,
    values,
    photos,
  };
}

export async function submitReady(overrides: Partial<SubmissionInput> = {}): Promise<SubmissionResult> {
  const assignment = await readyAssignment();
  return submitActivation(submissionFor(assignment, overrides));
}
