import type { ActivationState, EvidenceItem, ScoringMode } from "@prisma/client";
import type { Tx } from "@/lib/db";
import { notFound } from "@/lib/http/errors";
import { distanceKm, kmOutsideArea, nearestRegion, regionByCode, type JobArea } from "@/lib/geo";
import { agentStats, type AgentStats } from "@/lib/agents/history";
import { payoutAmountView } from "@/lib/payouts/amount";
import { configVersion, currentEvidenceConfig, type ConfigVersion } from "@/lib/evidence/config";
import { submittedFields, type SubmittedField } from "@/lib/evidence/view";
import { formatDistance } from "@/lib/format";
import { decisionsFor, type DecisionWithReasons } from "@/lib/scoring/decisions";
import { scoringHealth, type ScoringHealth } from "@/lib/scoring/status";
import { biggestConcern, byMagnitude, toReasonView, type ReasonView } from "./reasons";
import { queuePosition, type QueuePosition } from "./queue";

/**
 * Everything the review screen shows, assembled from stored records. A value
 * that is not recorded is returned as null so the screen can say it is
 * unavailable; nothing is estimated or filled in.
 */
export type EvidenceView = {
  id: string;
  sequence: number;
  kind: "photo" | "proof";
  /** The evidence field the file was attached to; null for a reply to an evidence request. */
  fieldKey: string | null;
  capturedAt: Date | null;
  gpsLat: number | null;
  gpsLon: number | null;
  gpsAccuracyM: number | null;
  locationSource: string;
  kmOutsideArea: number | null;
  /** Why the tile is flagged, written out for the reviewer; null when nothing is wrong. */
  flag: string | null;
  fromRequestId: string | null;
  url: string;
};

/** One group of the photo grid: a configured photo field, or the replies to evidence requests. */
export type PhotoGroup = { key: string; label: string; format: string | null; photos: EvidenceView[] };

export type EvidenceSummary = {
  photoCount: number;
  proofAttached: boolean;
  captureStart: Date | null;
  captureEnd: Date | null;
  accuracyMin: number | null;
  accuracyMax: number | null;
  withoutLocation: number;
  outside: Array<{ sequence: number; km: number }>;
};

export type PreviousSubmission = {
  id: string;
  reference: string;
  submittedAt: Date;
  gapMs: number;
  distanceKm: number;
  gpsLat: number;
  gpsLon: number;
};

export type DecisionView = {
  id: string;
  mode: ScoringMode;
  modelVersion: string;
  probability: number;
  band: "auto_release" | "review" | "reject";
  releaseThreshold: number;
  rejectThreshold: number;
  scoredAt: Date;
  trigger: string;
  reasons: ReasonView[];
};

export type ReviewDetail = Awaited<ReturnType<typeof reviewDetail>>;

export type AuditEntry = {
  at: Date;
  kind: string;
  fromState: ActivationState | null;
  toState: ActivationState | null;
  actorName: string | null;
  detail: string | null;
};

const TIMELINE_KINDS = ["transition", "scoring_failed", "t7_forced", "activity_reported", "scoring_decision", "dispute_opened", "payout_authorised"];

/** The activation's audit trail, oldest first, with actor names. Advisory scores only (primary ones show as transitions). */
async function auditTrail(db: Tx, activationId: string): Promise<AuditEntry[]> {
  const events = await db.auditEvent.findMany({ where: { activationId, kind: { in: TIMELINE_KINDS } }, orderBy: [{ at: "asc" }, { id: "asc" }] });
  const actorIds = [...new Set(events.flatMap((e) => (e.actorId ? [e.actorId] : [])))];
  const users = await db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } });
  const names = new Map(users.map((u) => [u.id, u.name]));
  return events
    .filter((e) => e.kind !== "scoring_decision" || (e.detail ?? "").includes("(advisory)"))
    .map((e) => ({ at: e.at, kind: e.kind, fromState: e.fromState, toState: e.toState, actorName: e.actorId ? names.get(e.actorId) ?? null : null, detail: e.detail }));
}

const detailInclude = {
  job: { include: { client: true } },
  agent: { include: { user: true } },
  assignment: { include: { hold: true } },
  evidence: { orderBy: { sequence: "asc" as const } },
  reviewItems: { orderBy: { openedAt: "asc" as const }, include: { reviewer: true } },
  evidenceRequests: { orderBy: { requestedAt: "asc" as const }, include: { requestedBy: true, items: true } },
  dispute: true,
  payout: true,
  commission: true,
  evidenceConfig: true,
};

function photoFlag(kind: "photo" | "proof", kmOutside: number | null): string | null {
  if (kind !== "photo") return null;
  if (kmOutside === null) return "No location recorded";
  return kmOutside > 0 ? `Taken ${formatDistance(kmOutside)} outside the job area` : null;
}

function evidenceView(item: EvidenceItem, area: JobArea): EvidenceView {
  const located = item.gpsLat !== null && item.gpsLon !== null;
  const kmOutside = located ? kmOutsideArea(area, item.gpsLat!, item.gpsLon!) : null;
  return {
    id: item.id,
    sequence: item.sequence,
    kind: item.kind,
    fieldKey: item.fieldKey,
    capturedAt: item.capturedAt,
    gpsLat: item.gpsLat,
    gpsLon: item.gpsLon,
    gpsAccuracyM: item.gpsAccuracyM,
    locationSource: item.locationSource,
    kmOutsideArea: kmOutside,
    flag: photoFlag(item.kind, kmOutside),
    fromRequestId: item.evidenceRequestId,
    url: `/api/evidence/${item.id}`,
  };
}

/** The photo grid's groups: each configured photo field in order, then any replies to evidence requests. */
function photoGroups(fields: SubmittedField[], photos: EvidenceView[]): PhotoGroup[] {
  const groups: PhotoGroup[] = fields
    .filter((field) => field.type === "photo")
    .map((field) => ({ key: field.key, label: field.label, format: field.format, photos: photos.filter((p) => p.fieldKey === field.key) }));
  const replies = photos.filter((p) => p.fromRequestId !== null);
  if (replies.length > 0) groups.push({ key: "replies", label: "Sent in reply to an evidence request", format: null, photos: replies });
  return groups;
}

function extent(values: number[]): [number | null, number | null] {
  return values.length === 0 ? [null, null] : [Math.min(...values), Math.max(...values)];
}

export function summariseEvidence(photos: EvidenceView[], proofAttached: boolean): EvidenceSummary {
  const times = photos.flatMap((p) => (p.capturedAt ? [p.capturedAt.getTime()] : []));
  const [start, end] = extent(times);
  const [accuracyMin, accuracyMax] = extent(photos.flatMap((p) => (p.gpsAccuracyM !== null ? [p.gpsAccuracyM] : [])));
  return {
    photoCount: photos.length,
    proofAttached,
    captureStart: start === null ? null : new Date(start),
    captureEnd: end === null ? null : new Date(end),
    accuracyMin,
    accuracyMax,
    withoutLocation: photos.filter((p) => p.kmOutsideArea === null).length,
    outside: photos.filter((p) => (p.kmOutsideArea ?? 0) > 0).map((p) => ({ sequence: p.sequence, km: p.kmOutsideArea! })),
  };
}

async function previousSubmission(
  db: Tx,
  activation: { id: string; agentId: string; submittedAt: Date; gpsLat: number; gpsLon: number },
): Promise<PreviousSubmission | null> {
  const previous = await db.activation.findFirst({
    where: { agentId: activation.agentId, submittedAt: { lt: activation.submittedAt }, id: { not: activation.id } },
    orderBy: { submittedAt: "desc" },
  });
  if (!previous) return null;
  return {
    id: previous.id,
    reference: previous.reference,
    submittedAt: previous.submittedAt,
    gapMs: activation.submittedAt.getTime() - previous.submittedAt.getTime(),
    distanceKm: distanceKm(previous.gpsLat, previous.gpsLon, activation.gpsLat, activation.gpsLon),
    gpsLat: previous.gpsLat,
    gpsLon: previous.gpsLon,
  };
}

function decisionView(decision: DecisionWithReasons): DecisionView {
  return {
    id: decision.id,
    mode: decision.mode,
    modelVersion: decision.modelVersion,
    probability: decision.probability,
    band: decision.band,
    releaseThreshold: decision.releaseThreshold,
    rejectThreshold: decision.rejectThreshold,
    scoredAt: decision.scoredAt,
    trigger: decision.trigger,
    reasons: byMagnitude(decision.reasons.map(toReasonView)),
  };
}

export type AllowedActions = {
  canApprove: boolean;
  canRefuse: boolean;
  canRequestEvidence: boolean;
  canForceT7: boolean;
};

export function allowedActions(state: ActivationState): AllowedActions {
  const reviewable = state === "in_review" || state === "disputed";
  return {
    canApprove: reviewable,
    canRefuse: reviewable,
    canRequestEvidence: state === "in_review",
    canForceT7: ["held", "in_review", "awaiting_evidence", "disputed"].includes(state),
  };
}

async function loadActivation(db: Tx, activationId: string) {
  const activation = await db.activation.findUnique({ where: { id: activationId }, include: detailInclude });
  if (!activation) throw notFound("Activation");
  return activation;
}

function agentCard(activation: Awaited<ReturnType<typeof loadActivation>>, stats: AgentStats) {
  const { agent } = activation;
  return {
    id: agent.id,
    name: agent.user.name,
    registeredAt: agent.registeredAt,
    payoutMsisdn: agent.payoutMsisdn,
    homeAreaName: agent.homeAreaName,
    homeLat: agent.homeLat,
    homeLon: agent.homeLon,
    stats,
  };
}

function submissionView(activation: Awaited<ReturnType<typeof loadActivation>>, area: JobArea) {
  return {
    gpsLat: activation.gpsLat,
    gpsLon: activation.gpsLon,
    gpsAccuracyM: activation.gpsAccuracyM,
    kmOutsideArea: kmOutsideArea(area, activation.gpsLat, activation.gpsLon),
    deviceId: activation.deviceId,
    deviceOs: activation.deviceOs,
    appVersion: activation.appVersion,
    networkType: activation.networkType,
    ipRegion: activation.ipRegion,
    ipRegionName: regionByCode(activation.ipRegion)?.name ?? null,
    gpsRegionName: nearestRegion(activation.gpsLat, activation.gpsLon).name,
    activationMethod: activation.activationMethod,
    customerMsisdnMasked: activation.customerMsisdnMasked,
    simRegisteredAt: activation.simRegisteredAt,
    agentNote: activation.agentNote,
  };
}

function historyViews(activation: Awaited<ReturnType<typeof loadActivation>>) {
  return {
    reviewHistory: activation.reviewItems.map((item) => ({
      id: item.id,
      openedAt: item.openedAt,
      openReason: item.openReason,
      closedAt: item.closedAt,
      action: item.action,
      reviewerName: item.reviewer?.name ?? null,
      reason: item.reason,
    })),
    evidenceRequests: activation.evidenceRequests.map((request) => ({
      id: request.id,
      requestedAt: request.requestedAt,
      requestedByName: request.requestedBy.name,
      message: request.message,
      status: request.status,
      respondedAt: request.respondedAt,
      responseNote: request.responseNote,
      itemSequences: request.items.map((item) => item.sequence),
    })),
  };
}

export async function reviewDetail(db: Tx, activationId: string) {
  const activation = await loadActivation(db, activationId);
  const area: JobArea = activation.job;
  const items = activation.evidence.map((item) => evidenceView(item, area));
  const photos = items.filter((item) => item.kind === "photo");
  const decisions = (await decisionsFor(db, activation.id)).map(decisionView);
  const latest = decisions.at(-1) ?? null;
  const [stats, previous, health, position, audit, current]: [AgentStats, PreviousSubmission | null, ScoringHealth, QueuePosition | null, AuditEntry[], ConfigVersion] =
    await Promise.all([
      agentStats(db, activation.agentId),
      previousSubmission(db, activation),
      scoringHealth(db, activation.id, activation.unscoredStage),
      queuePosition(db, activation.id),
      auditTrail(db, activation.id),
      currentEvidenceConfig(db, activation.jobId),
    ]);
  // Labels and order come from the version this submission was validated against, not the job's current one.
  const fields = submittedFields(configVersion(activation.evidenceConfig), activation.evidencePayload);
  return {
    id: activation.id,
    reference: activation.reference,
    state: activation.state,
    unscoredStage: activation.unscoredStage,
    submittedAt: activation.submittedAt,
    heldAt: activation.heldAt,
    holdClosesAt: activation.holdClosesAt,
    job: { id: activation.job.id, title: activation.job.title, areaName: activation.job.areaName, areaLat: area.areaLat, areaLon: area.areaLon, areaRadiusM: area.areaRadiusM, clientName: activation.job.client.name },
    agent: agentCard(activation, stats),
    submission: submissionView(activation, area),
    evidence: {
      configId: activation.evidenceConfigId,
      version: activation.evidenceConfig.version,
      currentVersion: current.version,
      fields,
      photoGroups: photoGroups(fields, photos),
    },
    photos,
    proof: items.find((item) => item.kind === "proof") ?? null,
    evidenceSummary: summariseEvidence(photos, activation.proofHash !== null),
    previous,
    decisions,
    latest,
    concern: latest ? biggestConcern(latest.reasons) : null,
    health,
    ...historyViews(activation),
    dispute: activation.dispute,
    payout: {
      amount: payoutAmountView({ job: activation.job, hold: activation.assignment.hold, commission: activation.commission }),
      payoutMsisdn: activation.agent.payoutMsisdn,
      authorisation: activation.payout,
    },
    actions: allowedActions(activation.state),
    position,
    audit,
  };
}
