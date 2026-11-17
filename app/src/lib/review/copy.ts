import type { ReviewOpenReason, ScoringMode } from "@prisma/client";
import { formatProbability } from "@/lib/format";
import { isMissingActivity } from "@/lib/scoring/messages";
import type { DecisionView } from "./detail";

/**
 * Words for the review screen. Every number in these sentences comes from
 * the scoring decision being described (its own probability and its own
 * cut-offs); nothing here holds a threshold of its own.
 */
export const MODEL_FRAMING =
  "An automated check against patterns in past submissions, which gives advice only and never moves money.";

export const CLOSING_LINE =
  "The model advises; you decide. Your decision and your reason are recorded and shared with the agent and the client.";

export function modelName(mode: ScoringMode): string {
  return mode === "t0" ? "Submission-time model (T0)" : "Hold-close model (T7)";
}

export function stageName(mode: ScoringMode): string {
  return mode === "t0" ? "at submission" : "at hold-close";
}

function bandSentence(decision: DecisionView): string {
  const p = formatProbability(decision.probability);
  const release = formatProbability(decision.releaseThreshold);
  const reject = formatProbability(decision.rejectThreshold);
  if (decision.band === "review") {
    return `At ${p} it falls between the auto-approve cut-off (${release}) and the auto-reject cut-off (${reject}), so it was sent to a person.`;
  }
  if (decision.band === "reject") {
    return `At ${p} it is above the auto-reject cut-off (${reject}).`;
  }
  return `At ${p} it is at or below the auto-approve cut-off (${release}).`;
}

/** The last failed scoring call for an activation, as recorded: its kind and its message. */
export type ScoringFailure = { kind: string; message: string };

/**
 * Why there is no score, in plain words. A hold-close score that cannot be
 * built because no first-week activity was reported says so; it is not a
 * fault of the scoring service. Anything else keeps the earlier wording.
 */
export function noScoreReason(stage: ScoringMode, failure: ScoringFailure | null): string {
  if (stage === "t7" && isMissingActivity(failure)) {
    return "the hold-close model needs the customer's first week of activity, and none has been reported";
  }
  if (failure?.kind === "missing_input") return `information the model needs was missing ${stageName(stage)}`;
  return `the model could not be reached ${stageName(stage)}`;
}

export function noScoreSentence(stage: ScoringMode, failure: ScoringFailure | null): string {
  return `No score: ${noScoreReason(stage, failure)}, so it was sent to a person instead of being released.`;
}

/** One line saying why this submission is in front of a person. */
export function whyHere(
  openReason: ReviewOpenReason | null,
  latest: DecisionView | null,
  unscoredStage: ScoringMode | null,
  failure: ScoringFailure | null = null,
): string {
  if (unscoredStage) return noScoreSentence(unscoredStage, failure);
  if (!latest) return "No score has been recorded for this submission.";
  if (openReason === "t0_reject_escalation" && latest.mode === "t0") {
    return `${bandSentence(latest)} A submission-time score never refuses on its own, so it was sent to a person before the hold window closed.`;
  }
  if (openReason === "dispute") return `The agent contested a refusal, so it is back with a person. ${bandSentence(latest)}`;
  if (openReason === "evidence_returned") return `The agent sent the evidence that was asked for. ${bandSentence(latest)}`;
  return bandSentence(latest);
}

const OPEN_REASON_LABELS: Record<ReviewOpenReason, string> = {
  band_review: "Between the cut-offs",
  t0_reject_escalation: "Escalated at submission",
  could_not_be_scored: "Could not be scored",
  evidence_returned: "Evidence returned",
  dispute: "Refusal contested",
};

export function openReasonLabel(reason: ReviewOpenReason | null): string {
  return reason ? OPEN_REASON_LABELS[reason] : "In review";
}

export function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const TRIGGER_LABELS: Record<string, string> = {
  submission: "at submission",
  hold_close: "when the hold window closed",
  admin_forced: "on an administrator's request",
  retry: "on a retry",
};

export function triggerLabel(trigger: string): string {
  return TRIGGER_LABELS[trigger] ?? trigger;
}
