import type { ActivationState, Band, ReviewOpenReason, ScoringMode } from "@prisma/client";
import type { Tx } from "@/lib/db";
import { payoutAmountView, type PayoutAmountView } from "@/lib/payouts/amount";
import { splitByLevel, toReasonView, type ReasonView } from "./reasons";

/**
 * The review queue. "waiting" holds everything a reviewer must decide (in
 * review, or a contested refusal); "evidence" holds items parked while the
 * agent gathers more evidence. Oldest first.
 */
export type QueueTab = "waiting" | "evidence";

export const TAB_STATES: Record<QueueTab, ActivationState[]> = {
  waiting: ["in_review", "disputed"],
  evidence: ["awaiting_evidence"],
};

export type QueueDecision = {
  mode: ScoringMode;
  probability: number;
  band: Band;
  releaseThreshold: number;
  rejectThreshold: number;
};

export type QueueRow = {
  id: string;
  reference: string;
  state: ActivationState;
  unscoredStage: ScoringMode | null;
  jobTitle: string;
  clientName: string;
  agentId: string;
  agentName: string;
  submittedAt: Date;
  waitingSince: Date;
  openReason: ReviewOpenReason | null;
  amount: PayoutAmountView | null;
  latest: QueueDecision | null;
  submissionReasons: ReasonView[];
  agentReasons: ReasonView[];
  failedAttempts: number;
  evidenceAsked: string | null;
};

const queueInclude = {
  job: { include: { client: true } },
  agent: { include: { user: true } },
  assignment: { include: { hold: true } },
  commission: true,
  reviewItems: { where: { closedAt: null }, orderBy: { openedAt: "desc" as const }, take: 1 },
  evidenceRequests: { where: { status: "open" as const }, orderBy: { requestedAt: "desc" as const }, take: 1 },
  decisions: { orderBy: { recordedAt: "desc" as const }, take: 1, include: { reasons: true } },
  _count: { select: { attempts: { where: { outcome: "failed" as const } } } },
};

async function loadRows(db: Tx, states: ActivationState[]) {
  return db.activation.findMany({ where: { state: { in: states } }, include: queueInclude });
}

type LoadedRow = Awaited<ReturnType<typeof loadRows>>[number];

function toRow(activation: LoadedRow): QueueRow {
  const openItem = activation.reviewItems[0];
  const request = activation.evidenceRequests[0];
  const decision = activation.decisions[0];
  const { submission, agent } = splitByLevel(decision?.reasons.map(toReasonView) ?? []);
  return {
    id: activation.id,
    reference: activation.reference,
    state: activation.state,
    unscoredStage: activation.unscoredStage,
    jobTitle: activation.job.title,
    clientName: activation.job.client.name,
    agentId: activation.agentId,
    agentName: activation.agent.user.name,
    submittedAt: activation.submittedAt,
    waitingSince: request?.requestedAt ?? openItem?.openedAt ?? activation.updatedAt,
    openReason: openItem?.openReason ?? null,
    amount: payoutAmountView({ job: activation.job, hold: activation.assignment.hold, commission: activation.commission }),
    latest: decision
      ? {
          mode: decision.mode,
          probability: decision.probability,
          band: decision.band,
          releaseThreshold: decision.releaseThreshold,
          rejectThreshold: decision.rejectThreshold,
        }
      : null,
    submissionReasons: submission,
    agentReasons: agent,
    failedAttempts: activation._count.attempts,
    evidenceAsked: request?.message ?? null,
  };
}

function oldestFirst(a: QueueRow, b: QueueRow): number {
  return a.waitingSince.getTime() - b.waitingSince.getTime() || a.reference.localeCompare(b.reference);
}

export async function listQueue(db: Tx, tab: QueueTab): Promise<QueueRow[]> {
  const rows = await loadRows(db, TAB_STATES[tab]);
  return rows.map(toRow).sort(oldestFirst);
}

export async function queueCount(db: Tx): Promise<number> {
  return db.activation.count({ where: { state: { in: TAB_STATES.waiting } } });
}

export type QueuePosition = { index: number; total: number; previousId: string | null; nextId: string | null };

/** Where an activation sits in the waiting queue, for "Submission N of M" and Previous / Next. */
export async function queuePosition(db: Tx, activationId: string): Promise<QueuePosition | null> {
  const ids = (await listQueue(db, "waiting")).map((row) => row.id);
  const index = ids.indexOf(activationId);
  if (index === -1) return null;
  return {
    index: index + 1,
    total: ids.length,
    previousId: index > 0 ? ids[index - 1] : null,
    nextId: index < ids.length - 1 ? ids[index + 1] : null,
  };
}
