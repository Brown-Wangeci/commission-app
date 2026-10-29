import type { Assignment, ClientBusiness, Job } from "@prisma/client";
import { prisma } from "@/lib/db";
import { acceptAssignment, assignJob } from "@/lib/escrow/holds";
import { fundEscrow } from "@/lib/escrow/client";
import { createJob, type JobInput } from "@/lib/jobs/jobs";
import { maxLiability } from "@/lib/money/commission";
import { submitActivation, type SubmissionInput, type SubmissionResult } from "@/lib/activations/submit";
import { createAgent, createClient, createUser, TEST_TERMS } from "./factories";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

export function photo(name = "photo.png"): File {
  return new File([PNG_BYTES], name, { type: "image/png" });
}

/**
 * A valid job as a client would post it: KSh 300.00 per approved submission,
 * 10 slots, in the same area as the factory job (submissionFor's GPS fix is
 * inside it).
 */
export function jobInput(overrides: Partial<JobInput> = {}): JobInput {
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
    ...overrides,
  };
}

/**
 * A job published through the real code: the client deposits exactly the
 * job's maximum liability (plus any extra), then publishes it.
 */
export async function publishFundedJob(
  overrides: Partial<JobInput> = {},
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

export function submissionFor(assignment: Assignment, overrides: Partial<SubmissionInput> = {}): SubmissionInput {
  return {
    agentId: assignment.agentId,
    assignmentId: assignment.id,
    customerMsisdn: "0711222333",
    simRegisteredAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
    activationMethod: "qr_scan",
    gpsLat: -1.2835,
    gpsLon: 36.8331,
    gpsAccuracyM: 8,
    device: { deviceId: "device-test-1", deviceOs: "android", appVersion: "3.4.0", networkType: "cellular", ipRegion: null },
    agentNote: null,
    photos: [
      { file: photo("a.png"), capturedAt: new Date(), gpsLat: -1.2835, gpsLon: 36.8331, gpsAccuracyM: 6, locationSource: "device" },
      { file: photo("b.png"), capturedAt: new Date(), gpsLat: null, gpsLon: null, gpsAccuracyM: null, locationSource: "none" },
    ],
    proof: photo("proof.png"),
    ...overrides,
  };
}

export async function submitReady(overrides: Partial<SubmissionInput> = {}): Promise<SubmissionResult> {
  const assignment = await readyAssignment();
  return submitActivation(submissionFor(assignment, overrides));
}
