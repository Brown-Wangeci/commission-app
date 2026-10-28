import type { ActivationState, Prisma, ScoringJob, ScoringMode } from "@prisma/client";
import { prisma } from "@/lib/db";
import { applyT0Decision } from "@/lib/activations/outcomes";
import { recordAuditEvent } from "@/lib/activations/transition";
import { callScoringWithRetry, type CallResult } from "./client";
import { recordDecision, type DecisionWithReasons, type ScoringTrigger } from "./decisions";
import { claimJob, completeJob, dueJobIds, rescheduleAfterFailure } from "./jobs";
import { buildScoreRequest, PayloadError } from "./payload";

/**
 * Runs durable scoring jobs. A job is either:
 * - primary: the call the lifecycle is waiting for (T0 on a submitted
 *   activation, T7 on a held one). Its band is applied.
 * - advisory: a score for an activation a reviewer already owns (a forced
 *   T7, or a retry after a failure). It is stored and shown, never acted on.
 * - obsolete: the activation has moved past the point the job was for.
 */
export type RunOutcome = "scored" | "advisory" | "failed" | "obsolete" | "not_claimed";

type JobPath = "primary" | "advisory" | "obsolete";

const PRIMARY_STATE: Record<ScoringMode, ActivationState> = { t0: "submitted", t7: "held" };
const ADVISORY_STATES: readonly ActivationState[] = ["in_review", "awaiting_evidence", "disputed"];

function pathFor(mode: ScoringMode, state: ActivationState): JobPath {
  if (state === PRIMARY_STATE[mode]) return "primary";
  if (ADVISORY_STATES.includes(state)) return "advisory";
  return "obsolete";
}

async function recordAttempt(activationId: string, mode: ScoringMode, result: CallResult): Promise<void> {
  await prisma.scoringAttempt.create({
    data: {
      activationId,
      mode,
      outcome: result.ok ? "succeeded" : "failed",
      errorKind: result.ok ? null : result.kind,
      errorMessage: result.ok ? null : result.message,
      durationMs: result.durationMs,
    },
  });
}

async function callService(job: ScoringJob): Promise<CallResult> {
  try {
    const payload = await buildScoreRequest(prisma, job.activationId, job.mode);
    return await callScoringWithRetry(payload, (result) => recordAttempt(job.activationId, job.mode, result));
  } catch (error) {
    if (!(error instanceof PayloadError)) throw error;
    const result: CallResult = { ok: false, kind: "missing_input", message: error.message, durationMs: 0 };
    await recordAttempt(job.activationId, job.mode, result);
    return result;
  }
}

async function applyDecision(
  path: JobPath,
  mode: ScoringMode,
  activationId: string,
  decision: DecisionWithReasons,
  now: Date,
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (path === "primary" && mode === "t0") await applyT0Decision(tx, activationId, decision, now);
  if (path === "advisory") {
    await tx.activation.updateMany({ where: { id: activationId, unscoredStage: mode }, data: { unscoredStage: null } });
  }
}

async function onSuccess(job: ScoringJob, path: JobPath, result: Extract<CallResult, { ok: true }>, now: Date) {
  const trigger = job.trigger as ScoringTrigger;
  await prisma.$transaction(async (tx) => {
    const decision = await recordDecision(tx, job.activationId, result.response, trigger);
    await applyDecision(path, job.mode, job.activationId, decision, now, tx);
    await recordAuditEvent(tx, {
      kind: "scoring_decision",
      activationId: job.activationId,
      detail: `${job.mode.toUpperCase()} scored (${path}): band ${decision.band}, probability ${decision.probability.toFixed(3)}, thresholds ${decision.releaseThreshold.toFixed(3)} / ${decision.rejectThreshold.toFixed(3)}.`,
      at: now,
    });
    await completeJob(tx, job.id, "succeeded");
  });
}

async function onFailure(job: ScoringJob, result: Extract<CallResult, { ok: false }>, now: Date): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const next = await rescheduleAfterFailure(tx, job, `${result.kind}: ${result.message}`, now);
    await recordAuditEvent(tx, {
      kind: "scoring_failed",
      activationId: job.activationId,
      detail: `${job.mode.toUpperCase()} could not be scored (${result.kind}: ${result.message}). ${next ? `Retrying at ${next.toISOString()}.` : "No retries left."}`,
      at: now,
    });
  });
}

/** Claims and runs one job. Safe to call from several workers at once. */
export async function runScoringJob(jobId: string, now: Date = new Date()): Promise<RunOutcome> {
  const job = await claimJob(jobId, now);
  if (!job) return "not_claimed";
  const activation = await prisma.activation.findUniqueOrThrow({ where: { id: job.activationId } });
  const path = pathFor(job.mode, activation.state);
  if (path === "obsolete") {
    await completeJob(prisma, job.id, "cancelled");
    return "obsolete";
  }
  const result = await callService(job);
  if (!result.ok) {
    await onFailure(job, result, now);
    return "failed";
  }
  await onSuccess(job, path, result, now);
  return path === "primary" ? "scored" : "advisory";
}

export type RunSummary = Record<RunOutcome, number>;

/** Runs every job that is due now. Used by the scheduler and the manual trigger. */
export async function runDueScoringJobs(now: Date = new Date(), limit = 50): Promise<RunSummary> {
  const summary: RunSummary = { scored: 0, advisory: 0, failed: 0, obsolete: 0, not_claimed: 0 };
  for (const id of await dueJobIds(now, limit)) {
    summary[await runScoringJob(id, now)] += 1;
  }
  return summary;
}
