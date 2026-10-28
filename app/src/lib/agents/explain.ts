import type { ActivationState, Dispute, ReviewItem, ScoringDecision, ScoringReason } from "@prisma/client";
import { formatDateTime, formatProbability } from "@/lib/format";
import { capitalise } from "@/lib/review/copy";

/**
 * The plain-language reason for an activation's status, as an agent or a
 * client sees it. A person's decision is quoted with the reason they gave; an
 * automatic decision quotes the model's own probability, cut-off and stated
 * reasons. Signed contributions are not shown outside the review screen.
 */
export type StatusInput = {
  state: ActivationState;
  unscoredStage: "t0" | "t7" | null;
  holdClosesAt: Date | null;
  decisions: Array<ScoringDecision & { reasons: ScoringReason[] }>;
  closedReviews: Array<Pick<ReviewItem, "action" | "reason" | "closedAt">>;
  openRequestMessage: string | null;
  dispute: Pick<Dispute, "status" | "refusalReason" | "refusedById" | "contestNote" | "resolutionNote"> | null;
  withdrawReason: string | null;
};

export type StatusExplanation = { headline: string; detail: string | null; modelReasons: string[] };

function lastHuman(input: StatusInput, action: "approved" | "refused") {
  return [...input.closedReviews].reverse().find((item) => item.action === action) ?? null;
}

function modelReasons(input: StatusInput): string[] {
  const latest = input.decisions.at(-1);
  return latest ? latest.reasons.filter((r) => r.contribution > 0).map((r) => capitalise(r.description)) : [];
}

function approved(input: StatusInput): StatusExplanation {
  const human = lastHuman(input, "approved");
  if (human) return { headline: "Approved by a reviewer", detail: human.reason, modelReasons: [] };
  const t7 = input.decisions.findLast((d) => d.mode === "t7");
  const detail = t7
    ? `Released automatically when the hold closed: the hold-close check gave ${formatProbability(t7.probability)}, at or below its release cut-off of ${formatProbability(t7.releaseThreshold)}.`
    : "Released.";
  return { headline: "Approved", detail, modelReasons: [] };
}

function refused(input: StatusInput): StatusExplanation {
  const human = lastHuman(input, "refused");
  const canContest = input.dispute?.status === "open";
  const contestLine = canContest ? " You can contest this once." : input.dispute?.status === "upheld" ? " The refusal was upheld after your contest." : "";
  if (human) return { headline: "Refused by a reviewer", detail: `${human.reason ?? ""}${contestLine}`, modelReasons: [] };
  return { headline: "Refused automatically", detail: `${input.dispute?.refusalReason ?? "Refused at hold-close."}${contestLine}`, modelReasons: modelReasons(input) };
}

export function explainStatus(input: StatusInput): StatusExplanation {
  switch (input.state) {
    case "submitted":
    case "scored_t0":
    case "scored_t7":
      return { headline: "Received", detail: "Your submission is being checked.", modelReasons: [] };
    case "held":
      return {
        headline: "Checked and on hold",
        detail: `Payment is held while the customer's first week is observed${input.holdClosesAt ? `, until ${formatDateTime(input.holdClosesAt)}` : ""}. It is then checked again and paid, sent to a reviewer, or refused.`,
        modelReasons: [],
      };
    case "in_review":
      return {
        headline: "With a reviewer",
        detail: input.unscoredStage
          ? "The automatic check could not run, so a person will decide. Nothing is paid or refused automatically in the meantime."
          : "A reviewer is checking your evidence. You will be told the decision and the reason.",
        modelReasons: [],
      };
    case "awaiting_evidence":
      return { headline: "A reviewer needs more evidence", detail: input.openRequestMessage, modelReasons: [] };
    case "approved":
      return approved(input);
    case "refused":
      return refused(input);
    case "disputed":
      return { headline: "Refusal contested", detail: "You contested the refusal. A reviewer will look at it again.", modelReasons: [] };
    case "withdrawn":
      return { headline: "Withdrawn", detail: input.withdrawReason ? `You withdrew it: ${input.withdrawReason}` : "You withdrew it.", modelReasons: [] };
  }
}
