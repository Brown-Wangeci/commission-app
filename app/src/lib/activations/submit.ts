import { createHash, randomUUID } from "node:crypto";
import type { ActivationState, LocationSource, NetworkType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { ApiError, badRequest, conflict, notFound } from "@/lib/http/errors";
import { formatDateTime } from "@/lib/format";
import { nearestRegion, regionByCode } from "@/lib/geo";
import { ensurePayoutCalendar } from "@/lib/payouts/calendar";
import { currentEvidenceConfig, type ConfigVersion } from "@/lib/evidence/config";
import { MAX_JOB_PHOTOS, nairobiDate, validateEvidence, type EvidenceValue, type FieldDefinition } from "@/lib/evidence/fields";
import { PLATFORM_FIELDS, platformValues, type PlatformValues } from "@/lib/evidence/platform";
import { removeActivationFiles, storeUpload, type StoredFile } from "@/lib/evidence/storage";
import { enqueueScoring } from "@/lib/scoring/jobs";
import { runScoringJob, type RunOutcome } from "@/lib/scoring/runner";
import { recordAuditEvent, setAuditContext } from "./transition";

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

/**
 * A submission as the agent made it. Evidence arrives as typed text and
 * photos keyed by field, for the platform's fields (src/lib/evidence/
 * platform.ts) and the job's configured fields alike, and is validated in one
 * pass against both (FR-12, issue #48). The device's own context (location,
 * device, network) is captured by the device, not typed as evidence.
 */
export type SubmissionInput = {
  agentId: string;
  assignmentId: string;
  /**
   * The configuration version the agent's form was rendered from. It must
   * still be the job's current version; a form opened before the client
   * changed the fields is refused so the agent can reload it. Trusted callers
   * (the seed, tests) may omit it to mean the current version.
   */
  evidenceConfigId?: string;
  /** Every non-photo value as typed, by field key. */
  values: Record<string, string>;
  /** Every photo, by field key ("proof" for proof of activation). */
  photos: Record<string, PhotoInput[]>;
  gpsLat: number;
  gpsLon: number;
  gpsAccuracyM: number | null;
  device: DeviceInput;
  submittedAt?: Date;
};

export type SubmissionResult = {
  activationId: string;
  reference: string;
  state: ActivationState;
  scoring: RunOutcome;
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** The most photos one evidence-request reply may carry; the same ceiling as one job's photo fields. */
export const MAX_PHOTOS = MAX_JOB_PHOTOS;

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
    include: { activation: true, job: true, agent: true },
  });
  if (!assignment || assignment.agentId !== input.agentId) throw notFound("Assignment");
  if (!assignment.acceptedAt) throw conflict("Accept the job before submitting an activation for it.");
  if (assignment.activation) throw conflict("An activation has already been submitted for this assignment.");
  return assignment;
}

function checkTiming(submittedAt: Date, acceptedAt: Date, deadlineAt: Date | null): void {
  if (submittedAt < acceptedAt) throw badRequest("Submission cannot precede acceptance of the job.");
  if (deadlineAt && submittedAt > deadlineAt) throw conflict(`This job's deadline (${formatDateTime(deadlineAt)}) has passed; it takes no more submissions.`);
}

/** The version in force: the job's current one, which the agent's form must have been rendered from. */
async function configInForce(jobId: string, renderedFrom: string | undefined): Promise<ConfigVersion> {
  const current = await currentEvidenceConfig(prisma, jobId);
  if (renderedFrom !== undefined && renderedFrom !== current.id) {
    throw conflict("The client changed this job's evidence fields after you opened the form. Reload the form and submit again.", {
      currentEvidenceConfigId: current.id,
      currentVersion: current.version,
    });
  }
  return current;
}

/**
 * Validates the platform's fields and the job's fields in one pass (FR-12).
 * A missing mandatory field is named in the message; every failure is
 * reported against its field as `fields.<key>`.
 */
function validateSubmission(input: SubmissionInput, jobFields: FieldDefinition[], submittedAt: Date) {
  const photoCounts = Object.fromEntries(Object.entries(input.photos).map(([key, photos]) => [key, photos.length]));
  const result = validateEvidence([...PLATFORM_FIELDS, ...jobFields], { values: input.values, photoCounts }, { today: nairobiDate(submittedAt) });
  if (!result.ok) {
    const details = result.issues.map((issue) => ({ path: `fields.${issue.key}`, message: `${issue.label}: ${issue.message}` }));
    const message = result.missing.length > 0
      ? `Missing mandatory field${result.missing.length === 1 ? "" : "s"}: ${result.missing.join(", ")}.`
      : `${result.issues.length} field${result.issues.length === 1 ? " is" : "s are"} not in the expected format.`;
    throw new ApiError(422, "validation_failed", message, details);
  }
  return result.values;
}

type StoredPhoto = StoredFile & PhotoInput & { sequence: number; fieldKey: string };

/**
 * Stores every photo in field order, numbered 1..N across the submission, and
 * returns the job fields' payload with each photo field holding its photos'
 * numbers. Proof of activation is a platform field, stored as kind "proof".
 */
async function storeEvidence(activationId: string, input: SubmissionInput, jobFields: FieldDefinition[]) {
  const photos: StoredPhoto[] = [];
  const sequencesByField: Record<string, number[]> = {};
  for (const field of jobFields) {
    if (field.type !== "photo") continue;
    for (const photo of input.photos[field.key] ?? []) {
      const sequence = photos.length + 1;
      const stored = await storeUpload(activationId, `photo-${sequence}`, photo.file);
      photos.push({ ...photo, ...stored, sequence, fieldKey: field.key });
      (sequencesByField[field.key] ??= []).push(sequence);
    }
  }
  const proofFile = input.photos.proof?.[0]?.file ?? null;
  const proof = proofFile ? await storeUpload(activationId, "proof", proofFile) : null;
  return { photos, proof, sequencesByField };
}

function evidenceRows(stored: Awaited<ReturnType<typeof storeEvidence>>): Prisma.EvidenceItemCreateWithoutActivationInput[] {
  const rows: Prisma.EvidenceItemCreateWithoutActivationInput[] = stored.photos.map((photo) => ({
    kind: "photo",
    fieldKey: photo.fieldKey,
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
    rows.push({ kind: "proof", fieldKey: "proof", sequence: rows.length + 1, locationSource: "none", ...stored.proof });
  }
  return rows;
}

/** The job fields' payload: validated values, with each photo field's count replaced by its photos' numbers. */
function jobPayload(jobFields: FieldDefinition[], values: Record<string, EvidenceValue>, sequencesByField: Record<string, number[]>): Prisma.InputJsonObject {
  const payload: Record<string, EvidenceValue> = {};
  for (const field of jobFields) {
    if (field.type === "photo") {
      if (sequencesByField[field.key]) payload[field.key] = sequencesByField[field.key];
    } else if (values[field.key] !== undefined) {
      payload[field.key] = values[field.key];
    }
  }
  return payload;
}

async function nextReference(tx: Prisma.TransactionClient): Promise<string> {
  const [row] = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('activation_reference_seq') AS n`;
  return `LF-${String(row.n).padStart(6, "0")}`;
}

export type RecordedSubmission = { activationId: string; reference: string; jobId: string; submittedAt: Date };

/**
 * Stores the activation and its evidence and schedules the T0 score in the
 * same transaction, so a crash after commit still gets it scored by the
 * scheduler. Does not run the score.
 */
export async function recordSubmission(input: SubmissionInput): Promise<RecordedSubmission> {
  const submittedAt = input.submittedAt ?? new Date();
  const assignment = await loadAssignment(input);
  checkTiming(submittedAt, assignment.acceptedAt!, assignment.job.deadlineAt);
  const evidenceConfig = await configInForce(assignment.jobId, input.evidenceConfigId);
  const values = validateSubmission(input, evidenceConfig.fields, submittedAt);
  const core: PlatformValues = platformValues(values);
  const activationId = randomUUID();
  await ensurePayoutCalendar(prisma, new Date(submittedAt.getTime() - 30 * DAY_MS), new Date(submittedAt.getTime() + 60 * DAY_MS));

  let jobId: string;
  let reference: string;
  try {
    const stored = await storeEvidence(activationId, input, evidenceConfig.fields);
    const photoCount = stored.photos.length;
    ({ jobId, reference } = await prisma.$transaction(async (tx) => {
      const ref = await nextReference(tx);
      await setAuditContext(tx, {
        actorId: assignment.agent.userId,
        note: `Submitted with ${photoCount} photo(s)${stored.proof ? " and proof of activation" : ""} against evidence configuration version ${evidenceConfig.version}.`,
        at: submittedAt,
      });
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
          customerMsisdnHash: hashMsisdn(core.customerMsisdn),
          customerMsisdnMasked: maskMsisdn(core.customerMsisdn),
          simRegisteredAt: core.simRegisteredAt,
          activationMethod: core.activationMethod,
          proofHash: stored.proof?.sha256 ?? null,
          agentNote: core.agentNote,
          evidenceConfigId: evidenceConfig.id,
          evidencePayload: jobPayload(evidenceConfig.fields, values, stored.sequencesByField),
          evidence: { create: evidenceRows(stored) },
        },
      });
      const job = await enqueueScoring(tx, { activationId, mode: "t0", dueAt: submittedAt, trigger: "submission" });
      await recordAuditEvent(tx, {
        kind: "activation_submitted",
        activationId,
        detail: `${ref} submitted for job "${assignment.job.title}" with ${photoCount} photo(s), against evidence configuration version ${evidenceConfig.version}.`,
        at: submittedAt,
      });
      return { jobId: job.id, reference: ref };
    }));
  } catch (error) {
    await removeActivationFiles(activationId);
    throw error;
  }

  return { activationId, reference, jobId, submittedAt };
}

/** Records the submission, then runs its T0 score straight away. */
export async function submitActivation(input: SubmissionInput): Promise<SubmissionResult> {
  const recorded = await recordSubmission(input);
  const scoring = await runScoringJob(recorded.jobId, recorded.submittedAt);
  const after = await prisma.activation.findUniqueOrThrow({ where: { id: recorded.activationId } });
  return { activationId: recorded.activationId, reference: recorded.reference, state: after.state, scoring };
}
