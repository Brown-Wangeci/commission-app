import type { Prisma } from "@prisma/client";
import { config } from "@/lib/config";
import { formatProbability } from "@/lib/format";
import { openReviewItem } from "@/lib/review/items";
import type { DecisionWithReasons } from "@/lib/scoring/decisions";
import { enqueueScoring } from "@/lib/scoring/jobs";
import { transitionActivation } from "./transition";

/**
 * What each band does. The thresholds that produced the band come from the
 * scoring service with every decision; nothing here compares a probability
 * against a number of its own.
 */

function scoreNote(decision: DecisionWithReasons): string {
  return `${decision.mode.toUpperCase()} ${decision.modelVersion}: ${formatProbability(decision.probability)}, band ${decision.band}`;
}

/**
 * Submission-time decision. T0 never moves money: auto_release and review
 * start the hold window; reject sends the activation to a reviewer at once.
 */
export async function applyT0Decision(
  tx: Prisma.TransactionClient,
  activationId: string,
  decision: DecisionWithReasons,
  now: Date,
): Promise<void> {
  await transitionActivation(tx, { activationId, from: "submitted", to: "scored_t0", note: scoreNote(decision), at: now });
  if (decision.band === "reject") {
    await transitionActivation(tx, {
      activationId,
      from: "scored_t0",
      to: "in_review",
      note: "Above the submission-time reject cut-off: escalated to a reviewer before the hold window closes.",
      at: now,
    });
    await openReviewItem(tx, activationId, "t0_reject_escalation", now);
    return;
  }
  const holdClosesAt = new Date(now.getTime() + config().HOLD_WINDOW_SECONDS * 1000);
  await transitionActivation(tx, {
    activationId,
    from: "scored_t0",
    to: "held",
    note: `Held until ${holdClosesAt.toISOString()} for the hold-close score.`,
    at: now,
    data: { heldAt: now, holdClosesAt },
  });
  await enqueueScoring(tx, { activationId, mode: "t7", dueAt: holdClosesAt, trigger: "hold_close" });
}
