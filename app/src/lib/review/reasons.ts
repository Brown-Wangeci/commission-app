import type { ScoringReason } from "@prisma/client";

/** A model factor as the interface shows it. */
export type ReasonView = {
  rank: number;
  feature: string;
  description: string;
  contribution: number;
  raisesRisk: boolean;
  isAgentLevel: boolean;
};

export function toReasonView(reason: ScoringReason): ReasonView {
  return {
    rank: reason.rank,
    feature: reason.feature,
    description: reason.description,
    contribution: reason.contribution,
    raisesRisk: reason.contribution > 0,
    isAgentLevel: reason.isAgentLevel,
  };
}

/** Largest absolute contribution first. */
export function byMagnitude(reasons: ReasonView[]): ReasonView[] {
  return [...reasons].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
}

/** The factor that raised the risk most, or null if none raised it. */
export function biggestConcern(reasons: ReasonView[]): ReasonView | null {
  const raising = reasons.filter((reason) => reason.raisesRisk);
  if (raising.length === 0) return null;
  return raising.reduce((top, reason) => (reason.contribution > top.contribution ? reason : top));
}

/** Splits factors about the agent's history from factors about this submission. */
export function splitByLevel(reasons: ReasonView[]): { submission: ReasonView[]; agent: ReasonView[] } {
  return {
    submission: byMagnitude(reasons.filter((reason) => !reason.isAgentLevel)),
    agent: byMagnitude(reasons.filter((reason) => reason.isAgentLevel)),
  };
}

/** Share of the shown explanation (by absolute contribution) that is about the agent. */
export function agentShare(reasons: ReasonView[]): number | null {
  const total = reasons.reduce((sum, reason) => sum + Math.abs(reason.contribution), 0);
  if (total === 0) return null;
  const agent = reasons.filter((r) => r.isAgentLevel).reduce((sum, r) => sum + Math.abs(r.contribution), 0);
  return agent / total;
}
