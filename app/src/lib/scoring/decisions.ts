import type { Prisma, ScoringDecision, ScoringReason } from "@prisma/client";
import type { Tx } from "@/lib/db";
import type { ScoreResponse } from "./contract";

/** Why a scoring call was made, recorded with each decision. */
export type ScoringTrigger = "submission" | "hold_close" | "admin_forced" | "retry";

export type DecisionWithReasons = ScoringDecision & { reasons: ScoringReason[] };

/**
 * Appends one scoring decision and its reasons. Decisions are never updated:
 * a rescore adds a new row (issue #4), and the database rejects any UPDATE or
 * DELETE on these tables.
 */
export async function recordDecision(
  tx: Tx,
  activationId: string,
  response: ScoreResponse,
  trigger: ScoringTrigger,
): Promise<DecisionWithReasons> {
  const reasons: Prisma.ScoringReasonCreateWithoutDecisionInput[] = response.top_reasons.map(
    (reason, index) => ({
      rank: index + 1,
      feature: reason.feature,
      description: reason.description,
      contribution: reason.shap_value,
      direction: reason.direction,
      isAgentLevel: reason.is_agent_level,
    }),
  );
  return tx.scoringDecision.create({
    data: {
      activationId,
      mode: response.mode,
      modelVersion: response.model_version,
      featureSet: response.feature_set,
      rawScore: response.raw_score,
      probability: response.calibrated_probability,
      band: response.band,
      releaseThreshold: response.release_threshold,
      rejectThreshold: response.reject_threshold,
      scoredAt: new Date(response.scored_at),
      trigger,
      reasons: { create: reasons },
    },
    include: { reasons: { orderBy: { rank: "asc" } } },
  });
}

/** Every decision for an activation, oldest first, with reasons in rank order. */
export async function decisionsFor(tx: Tx, activationId: string): Promise<DecisionWithReasons[]> {
  return tx.scoringDecision.findMany({
    where: { activationId },
    orderBy: { recordedAt: "asc" },
    include: { reasons: { orderBy: { rank: "asc" } } },
  });
}

/** The most recent decision, or null if the activation was never scored. */
export async function latestDecision(
  tx: Tx,
  activationId: string,
): Promise<DecisionWithReasons | null> {
  return tx.scoringDecision.findFirst({
    where: { activationId },
    orderBy: { recordedAt: "desc" },
    include: { reasons: { orderBy: { rank: "asc" } } },
  });
}
