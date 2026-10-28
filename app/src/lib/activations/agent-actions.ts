import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { badRequest, conflict, notFound } from "@/lib/http/errors";
import { notify } from "@/lib/notifications";
import { storeUpload } from "@/lib/evidence/storage";
import { closeReviewItem, openReviewItem } from "@/lib/review/items";
import { WITHDRAWABLE_STATES } from "./states";
import { MAX_PHOTOS, type PhotoInput } from "./submit";
import { recordAuditEvent, transitionActivation } from "./transition";

async function ownActivation(tx: Prisma.TransactionClient, agentId: string, activationId: string) {
  const activation = await tx.activation.findUnique({ where: { id: activationId } });
  if (!activation || activation.agentId !== agentId) throw notFound("Activation");
  return activation;
}

export type EvidenceResponse = {
  agentId: string;
  activationId: string;
  note: string | null;
  photos: PhotoInput[];
  at?: Date;
};

async function storeResponsePhotos(activationId: string, firstSequence: number, photos: PhotoInput[]) {
  const stored = [];
  for (const [index, photo] of photos.entries()) {
    const sequence = firstSequence + index;
    stored.push({ ...photo, ...(await storeUpload(activationId, `photo-${sequence}`, photo.file)), sequence });
  }
  return stored;
}

/**
 * The agent answers an evidence request with a note and/or more photos. The
 * request is marked answered, the activation returns to the review queue,
 * and the reviewer who asked is notified.
 */
export async function respondToEvidenceRequest(input: EvidenceResponse): Promise<void> {
  if (!input.note && input.photos.length === 0) throw badRequest("Add a note or at least one photo.");
  if (input.photos.length > MAX_PHOTOS) throw badRequest(`Attach at most ${MAX_PHOTOS} photos.`);
  const at = input.at ?? new Date();
  const activation = await ownActivation(prisma, input.agentId, input.activationId);
  if (activation.state !== "awaiting_evidence") throw conflict("No evidence has been asked for on this activation.");
  const last = await prisma.evidenceItem.aggregate({ where: { activationId: activation.id }, _max: { sequence: true } });
  const stored = await storeResponsePhotos(activation.id, (last._max.sequence ?? 0) + 1, input.photos);

  await prisma.$transaction(async (tx) => {
    const request = await tx.evidenceRequest.findFirst({ where: { activationId: activation.id, status: "open" } });
    if (!request) throw conflict("No evidence has been asked for on this activation.");
    for (const photo of stored) {
      await tx.evidenceItem.create({
        data: {
          activationId: activation.id, evidenceRequestId: request.id, kind: "photo", sequence: photo.sequence,
          fileName: photo.fileName, mimeType: photo.mimeType, storagePath: photo.storagePath, sha256: photo.sha256,
          capturedAt: photo.capturedAt, gpsLat: photo.gpsLat, gpsLon: photo.gpsLon, gpsAccuracyM: photo.gpsAccuracyM,
          locationSource: photo.locationSource,
        },
      });
    }
    await tx.evidenceRequest.update({ where: { id: request.id }, data: { status: "answered", respondedAt: at, responseNote: input.note } });
    await transitionActivation(tx, {
      activationId: activation.id, from: "awaiting_evidence", to: "in_review",
      note: `Agent responded with ${stored.length} photo(s)${input.note ? " and a note" : ""}.`, at,
    });
    await openReviewItem(tx, activation.id, "evidence_returned", at);
    await notify(tx, {
      userId: request.requestedById, kind: "evidence_returned", activationId: activation.id,
      message: `${activation.reference}: the agent responded to your evidence request.`,
    });
  });
}

/** The agent withdraws an activation that is not yet decided. Its escrow returns to the job. */
export async function withdrawActivation(input: { agentId: string; activationId: string; reason: string; at?: Date }): Promise<void> {
  const at = input.at ?? new Date();
  await prisma.$transaction(async (tx) => {
    const activation = await ownActivation(tx, input.agentId, input.activationId);
    if (!WITHDRAWABLE_STATES.includes(activation.state)) {
      throw conflict(`An activation that is ${activation.state.replace("_", " ")} cannot be withdrawn.`);
    }
    await transitionActivation(tx, {
      activationId: activation.id, from: activation.state, to: "withdrawn", note: `Withdrawn by the agent: ${input.reason}`, at,
    });
    await closeReviewItem(tx, { activationId: activation.id, action: "withdrawn_by_agent", reviewerId: null, reason: input.reason, decisionId: null, at });
    await tx.evidenceRequest.updateMany({ where: { activationId: activation.id, status: "open" }, data: { status: "withdrawn" } });
    await tx.scoringJob.updateMany({ where: { activationId: activation.id, status: "pending" }, data: { status: "cancelled" } });
    await recordAuditEvent(tx, { kind: "activation_withdrawn", activationId: activation.id, detail: input.reason, at });
  });
}

