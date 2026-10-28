import { createHash, randomUUID } from "node:crypto";
import type { ActivationMethod, ActivationState, LocationSource, NetworkType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { badRequest, conflict, notFound } from "@/lib/http/errors";
import { nearestRegion, regionByCode } from "@/lib/geo";
import { ensurePayoutCalendar } from "@/lib/payouts/calendar";
import { removeActivationFiles, storeUpload, type StoredFile } from "@/lib/evidence/storage";
import { enqueueScoring } from "@/lib/scoring/jobs";
import { runScoringJob, type RunOutcome } from "@/lib/scoring/runner";
import { recordAuditEvent } from "./transition";

export type PhotoInput = {
  file: File;
  capturedAt: Date | null;
  gpsLat: number | null;
  gpsLon: number | null;
  gpsAccuracyM: number | null;
  locationSource: LocationSource;
};

export type DeviceInput = {
  deviceId: string;
  deviceOs: string;
  appVersion: string;
  networkType: NetworkType;
  /** Region code reported for the submitting network; null means "derive from GPS". */
  ipRegion: string | null;
};

export type SubmissionInput = {
  agentId: string;
  assignmentId: string;
  customerMsisdn: string;
  simRegisteredAt: Date;
  activationMethod: ActivationMethod;
  gpsLat: number;
  gpsLon: number;
  gpsAccuracyM: number | null;
  device: DeviceInput;
  agentNote: string | null;
  photos: PhotoInput[];
  proof: File | null;
  submittedAt?: Date;
};

export type SubmissionResult = {
  activationId: string;
  reference: string;
  state: ActivationState;
  scoring: RunOutcome;
};

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_PHOTOS = 12;

export function hashMsisdn(normalised: string): string {
  return createHash("sha256").update(`${config().MSISDN_HASH_SALT}:${normalised}`).digest("hex");
}

export function maskMsisdn(normalised: string): string {
  return `${normalised.slice(0, 2)}** *** ${normalised.slice(-3)}`;
}

function resolveIpRegion(device: DeviceInput, lat: number, lon: number): string {
  if (device.ipRegion === null) return nearestRegion(lat, lon).code;
  if (!regionByCode(device.ipRegion)) throw badRequest(`Unknown network region ${device.ipRegion}.`);
  return device.ipRegion;
}

async function loadAssignment(input: SubmissionInput) {
  const assignment = await prisma.assignment.findUnique({
    where: { id: input.assignmentId },
    include: { activation: true, job: true },
  });
  if (!assignment || assignment.agentId !== input.agentId) throw notFound("Assignment");
  if (!assignment.acceptedAt) throw conflict("Accept the job before submitting an activation for it.");
  if (assignment.activation) throw conflict("An activation has already been submitted for this assignment.");
  return assignment;
}

function checkInput(input: SubmissionInput, submittedAt: Date, acceptedAt: Date): void {
  if (input.photos.length === 0) throw badRequest("Attach at least one evidence photo.");
  if (input.photos.length > MAX_PHOTOS) throw badRequest(`Attach at most ${MAX_PHOTOS} photos.`);
  if (input.simRegisteredAt > submittedAt) throw badRequest("The SIM registration date cannot be in the future.");
  if (submittedAt < acceptedAt) throw badRequest("Submission cannot precede acceptance of the job.");
}

async function storeEvidence(activationId: string, input: SubmissionInput) {
  const photos: Array<StoredFile & PhotoInput & { sequence: number }> = [];
  for (const [index, photo] of input.photos.entries()) {
    const stored = await storeUpload(activationId, `photo-${index + 1}`, photo.file);
    photos.push({ ...photo, ...stored, sequence: index + 1 });
  }
  const proof = input.proof ? await storeUpload(activationId, "proof", input.proof) : null;
  return { photos, proof };
}

function evidenceRows(
  stored: Awaited<ReturnType<typeof storeEvidence>>,
): Prisma.EvidenceItemCreateWithoutActivationInput[] {
  const rows: Prisma.EvidenceItemCreateWithoutActivationInput[] = stored.photos.map((photo) => ({
    kind: "photo",
    sequence: photo.sequence,
    fileName: photo.fileName,
    mimeType: photo.mimeType,
    storagePath: photo.storagePath,
    sha256: photo.sha256,
    capturedAt: photo.capturedAt,
    gpsLat: photo.gpsLat,
    gpsLon: photo.gpsLon,
    gpsAccuracyM: photo.gpsAccuracyM,
    locationSource: photo.locationSource,
  }));
  if (stored.proof) {
    rows.push({ kind: "proof", sequence: rows.length + 1, locationSource: "none", ...stored.proof });
  }
  return rows;
}

async function nextReference(tx: Prisma.TransactionClient): Promise<string> {
  const [row] = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('activation_reference_seq') AS n`;
  return `LF-${String(row.n).padStart(6, "0")}`;
}

/**
 * Stores the activation and its evidence, schedules the T0 score in the same
 * transaction (so a crash after commit still gets it scored by the
 * scheduler), then runs that score straight away.
 */
export async function submitActivation(input: SubmissionInput): Promise<SubmissionResult> {
  const submittedAt = input.submittedAt ?? new Date();
  const assignment = await loadAssignment(input);
  checkInput(input, submittedAt, assignment.acceptedAt!);
  const activationId = randomUUID();
  const normalised = input.customerMsisdn;
  await ensurePayoutCalendar(prisma, new Date(submittedAt.getTime() - 30 * DAY_MS), new Date(submittedAt.getTime() + 60 * DAY_MS));

  let jobId: string;
  let reference: string;
  try {
    const stored = await storeEvidence(activationId, input);
    ({ jobId, reference } = await prisma.$transaction(async (tx) => {
      const ref = await nextReference(tx);
      await tx.activation.create({
        data: {
          id: activationId,
          reference: ref,
          assignmentId: assignment.id,
          agentId: assignment.agentId,
          jobId: assignment.jobId,
          submittedAt,
          deviceId: input.device.deviceId,
          deviceOs: input.device.deviceOs,
          appVersion: input.device.appVersion,
          ipRegion: resolveIpRegion(input.device, input.gpsLat, input.gpsLon),
          networkType: input.device.networkType,
          gpsLat: input.gpsLat,
          gpsLon: input.gpsLon,
          gpsAccuracyM: input.gpsAccuracyM,
          customerMsisdnHash: hashMsisdn(normalised),
          customerMsisdnMasked: maskMsisdn(normalised),
          simRegisteredAt: input.simRegisteredAt,
          activationMethod: input.activationMethod,
          proofHash: stored.proof?.sha256 ?? null,
          agentNote: input.agentNote,
          evidence: { create: evidenceRows(stored) },
        },
      });
      const job = await enqueueScoring(tx, { activationId, mode: "t0", dueAt: submittedAt, trigger: "submission" });
      await recordAuditEvent(tx, {
        kind: "activation_submitted",
        activationId,
        detail: `${ref} submitted for job "${assignment.job.title}" with ${input.photos.length} photo(s).`,
        at: submittedAt,
      });
      return { jobId: job.id, reference: ref };
    }));
  } catch (error) {
    await removeActivationFiles(activationId);
    throw error;
  }

  const scoring = await runScoringJob(jobId, submittedAt);
  const after = await prisma.activation.findUniqueOrThrow({ where: { id: activationId } });
  return { activationId, reference, state: after.state, scoring };
}
