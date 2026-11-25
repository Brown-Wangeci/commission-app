import { createHash } from "node:crypto";
import type { Band, ReviewOpenReason, ScoringMode } from "@prisma/client";
import type { Tx } from "@/lib/db";

/**
 * DR-10: the labelled records a reviewer's decisions leave behind, exported
 * for retraining.
 *
 * One row per reviewed submission: the feature vector the model actually
 * scored, stored with the decision and never recomputed, and the final human
 * decision as the label. Nothing that identifies a person leaves here. Each
 * row is built field by field from the list below, so a column cannot be
 * added by accident when a query changes; app/tests/label-export.test.ts
 * checks the exported bytes against the personal data the database holds for
 * the same submissions.
 *
 * What is deliberately not exported: the activation id and reference, the
 * agent and reviewer ids, the customer's number, the device, the GPS fix, the
 * evidence payload and every piece of free text. Agents are exported only as
 * an opaque group number, so a split can keep one agent's rows together
 * without naming them; the numbering is meaningful inside one export and
 * carries nothing from outside it.
 */

export const DATASET_NAME = "ledgerfield-review-labels";

/** The label a human decision becomes: 1 the reviewer refused, 0 the reviewer approved. */
export const LABEL_FOR = { refused: 1, approved: 0 } as const;

export type LabelDecision = keyof typeof LABEL_FOR;

export const LABEL_DECISIONS = Object.keys(LABEL_FOR) as LabelDecision[];

/** Every field of an exported row, in the order it is written. */
export const ROW_FIELDS = [
  "row",
  "agent_group",
  "mode",
  "feature_set",
  "model_version",
  "model_probability",
  "model_band",
  "release_threshold",
  "reject_threshold",
  "scored_at",
  "decided_at",
  "decision",
  "label",
  "reviewer_role",
  "open_reason",
  "features",
] as const;

export type ReviewLabelRow = {
  /** Position in this export, from 1. Not an identifier of anything outside it. */
  row: number;
  /** Which rows belong to one agent, for an agent-grouped split. Opaque, and only meaningful within this export. */
  agent_group: number;
  mode: ScoringMode;
  feature_set: string;
  model_version: string;
  model_probability: number;
  model_band: Band;
  release_threshold: number;
  reject_threshold: number;
  scored_at: string;
  decided_at: string;
  decision: LabelDecision;
  label: 0 | 1;
  reviewer_role: string;
  open_reason: ReviewOpenReason;
  /** The feature vector as the scoring service computed it, by feature name. */
  features: Record<string, number>;
};

export type SkippedCounts = {
  /** Reviewed, but the decision in force stored no feature vector (decisions recorded before it was kept). */
  noFeatureVector: number;
  /** Reviewed, but no scoring decision had been recorded when the reviewer decided. */
  noDecision: number;
};

export type ReviewLabelManifest = {
  dataset: typeof DATASET_NAME;
  version: string;
  exportedAt: string;
  rows: number;
  labels: Record<LabelDecision, number>;
  byMode: Record<string, number>;
  byOpenReason: Record<string, number>;
  byModelVersion: Record<string, number>;
  agentGroups: number;
  featureNames: Record<string, string[]>;
  decisionRange: { first: string | null; last: string | null };
  skipped: SkippedCounts;
  /** SHA-256 of the exact bytes of labels.jsonl, which `serialiseRows` produces. */
  sha256: string;
  labelMeaning: Record<LabelDecision, 0 | 1>;
  fields: string[];
  containsPersonalData: false;
};

export type ReviewLabelExport = { manifest: ReviewLabelManifest; rows: ReviewLabelRow[] };

function featureVectorOf(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || !entries.every(([, number]) => typeof number === "number" && Number.isFinite(number))) return null;
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))) as Record<string, number>;
}

type ClosedItem = {
  activationId: string;
  agentId: string;
  closedAt: Date;
  decision: LabelDecision;
  reviewerRole: string;
  openReason: ReviewOpenReason;
  decisionId: string | null;
};

/** The last decision a person recorded on each reviewed submission, oldest first. */
async function finalDecisions(db: Tx): Promise<ClosedItem[]> {
  const items = await db.reviewItem.findMany({
    where: { closedAt: { not: null }, action: { in: [...LABEL_DECISIONS] }, reviewerId: { not: null } },
    orderBy: [{ closedAt: "asc" }, { id: "asc" }],
    include: { reviewer: { select: { role: true } }, activation: { select: { agentId: true } } },
  });
  const latest = new Map<string, ClosedItem>();
  for (const item of items) {
    // Ascending, so a later decision (a dispute resolved after a refusal) replaces the earlier one.
    latest.set(item.activationId, {
      activationId: item.activationId,
      agentId: item.activation.agentId,
      closedAt: item.closedAt!,
      decision: item.action as LabelDecision,
      reviewerRole: item.reviewer?.role ?? "admin",
      openReason: item.openReason,
      decisionId: item.decisionId,
    });
  }
  return [...latest.values()].sort(
    (a, b) => a.closedAt.getTime() - b.closedAt.getTime() || a.activationId.localeCompare(b.activationId),
  );
}

type Scored = { id: string; activationId: string; recordedAt: Date; mode: ScoringMode; featureSet: string; modelVersion: string; probability: number; band: Band; releaseThreshold: number; rejectThreshold: number; scoredAt: Date; featureVector: unknown };

/**
 * The decision the reviewer was looking at: the one the review item recorded
 * when it closed, or failing that the newest recorded by then.
 */
function decisionInForce(item: ClosedItem, byActivation: Map<string, Scored[]>): Scored | null {
  const decisions = byActivation.get(item.activationId) ?? [];
  const named = item.decisionId ? decisions.find((decision) => decision.id === item.decisionId) : undefined;
  if (named) return named;
  const earlier = decisions.filter((decision) => decision.recordedAt <= item.closedAt);
  return earlier.at(-1) ?? null;
}

export async function collectReviewLabels(db: Tx): Promise<{ rows: ReviewLabelRow[]; skipped: SkippedCounts }> {
  const items = await finalDecisions(db);
  const decisions = await db.scoringDecision.findMany({
    where: { activationId: { in: items.map((item) => item.activationId) } },
    orderBy: { recordedAt: "asc" },
    select: { id: true, activationId: true, recordedAt: true, mode: true, featureSet: true, modelVersion: true, probability: true, band: true, releaseThreshold: true, rejectThreshold: true, scoredAt: true, featureVector: true },
  });
  const byActivation = new Map<string, Scored[]>();
  for (const decision of decisions) {
    byActivation.set(decision.activationId, [...(byActivation.get(decision.activationId) ?? []), decision]);
  }

  const skipped: SkippedCounts = { noFeatureVector: 0, noDecision: 0 };
  const groups = new Map<string, number>();
  const rows: ReviewLabelRow[] = [];
  for (const item of items) {
    const decision = decisionInForce(item, byActivation);
    if (!decision) {
      skipped.noDecision += 1;
      continue;
    }
    const features = featureVectorOf(decision.featureVector);
    if (!features) {
      skipped.noFeatureVector += 1;
      continue;
    }
    if (!groups.has(item.agentId)) groups.set(item.agentId, groups.size + 1);
    rows.push({
      row: rows.length + 1,
      agent_group: groups.get(item.agentId)!,
      mode: decision.mode,
      feature_set: decision.featureSet,
      model_version: decision.modelVersion,
      model_probability: decision.probability,
      model_band: decision.band,
      release_threshold: decision.releaseThreshold,
      reject_threshold: decision.rejectThreshold,
      scored_at: decision.scoredAt.toISOString(),
      decided_at: item.closedAt.toISOString(),
      decision: item.decision,
      label: LABEL_FOR[item.decision],
      reviewer_role: item.reviewerRole,
      open_reason: item.openReason,
      features,
    });
  }
  return { rows, skipped };
}

/** One JSON object per line, fields in `ROW_FIELDS` order and features by name, so the bytes are the same every time. */
export function serialiseRows(rows: ReviewLabelRow[]): string {
  return rows
    .map((row) => JSON.stringify(Object.fromEntries(ROW_FIELDS.map((field) => [field, row[field]]))))
    .join("\n")
    .concat(rows.length > 0 ? "\n" : "");
}

function countBy<T extends string>(rows: ReviewLabelRow[], pick: (row: ReviewLabelRow) => T): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[pick(row)] = (counts[pick(row)] ?? 0) + 1;
  return counts;
}

/** The feature names seen for each mode, sorted. The two modes score different feature sets. */
function featureNames(rows: ReviewLabelRow[]): Record<string, string[]> {
  const names: Record<string, Set<string>> = {};
  for (const row of rows) {
    names[row.mode] = new Set([...(names[row.mode] ?? []), ...Object.keys(row.features)]);
  }
  return Object.fromEntries(Object.entries(names).map(([mode, set]) => [mode, [...set].sort()]));
}

/** A version that sorts by time and says when it was taken, e.g. review-labels-20261125T120000Z. */
export function versionFor(at: Date): string {
  return `review-labels-${at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
}

export async function exportReviewLabels(db: Tx, options: { version?: string; at?: Date } = {}): Promise<ReviewLabelExport> {
  const at = options.at ?? new Date();
  const { rows, skipped } = await collectReviewLabels(db);
  const manifest: ReviewLabelManifest = {
    dataset: DATASET_NAME,
    version: options.version ?? versionFor(at),
    exportedAt: at.toISOString(),
    rows: rows.length,
    labels: {
      approved: rows.filter((row) => row.decision === "approved").length,
      refused: rows.filter((row) => row.decision === "refused").length,
    },
    byMode: countBy(rows, (row) => row.mode),
    byOpenReason: countBy(rows, (row) => row.open_reason),
    byModelVersion: countBy(rows, (row) => row.model_version),
    agentGroups: new Set(rows.map((row) => row.agent_group)).size,
    featureNames: featureNames(rows),
    decisionRange: { first: rows[0]?.decided_at ?? null, last: rows.at(-1)?.decided_at ?? null },
    skipped,
    sha256: createHash("sha256").update(serialiseRows(rows), "utf8").digest("hex"),
    labelMeaning: LABEL_FOR,
    fields: [...ROW_FIELDS],
    containsPersonalData: false,
  };
  return { manifest, rows };
}
