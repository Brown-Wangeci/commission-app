import type { ActivationState } from "@prisma/client";

/**
 * The activation lifecycle, defined once. The database enforces the same
 * table: migration 20261028193000_state_machine loads these pairs into
 * "ActivationTransitionRule", a trigger rejects any UPDATE that is not one
 * of them, and tests/state-machine.test.ts fails if the two ever differ.
 *
 *   submitted         -> scored_t0 (T0 scored) | in_review (T0 could not be scored)
 *   scored_t0         -> held (T0 band auto_release or review) | in_review (T0 band reject: escalated)
 *   held              -> scored_t7 (T7 scored) | in_review (T7 could not be scored) | withdrawn
 *   scored_t7         -> approved (auto_release) | in_review (review) | refused (reject)
 *   in_review         -> approved | refused | awaiting_evidence | withdrawn
 *   awaiting_evidence -> in_review (agent responded) | withdrawn
 *   refused           -> disputed (agent contests the refusal)
 *   disputed          -> approved (refusal overturned) | refused (refusal upheld)
 *   approved, withdrawn: final
 */
export const TRANSITIONS: Readonly<Record<ActivationState, readonly ActivationState[]>> = {
  submitted: ["scored_t0", "in_review"],
  scored_t0: ["held", "in_review"],
  held: ["scored_t7", "in_review", "withdrawn"],
  scored_t7: ["approved", "in_review", "refused"],
  in_review: ["approved", "refused", "awaiting_evidence", "withdrawn"],
  awaiting_evidence: ["in_review", "withdrawn"],
  approved: [],
  refused: ["disputed"],
  disputed: ["approved", "refused"],
  withdrawn: [],
};

export const ALL_STATES = Object.keys(TRANSITIONS) as ActivationState[];

/** The only state an activation may be created in. */
export const INITIAL_STATE: ActivationState = "submitted";

export function isLegalTransition(from: ActivationState, to: ActivationState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isFinal(state: ActivationState): boolean {
  return TRANSITIONS[state].length === 0;
}

/** Every legal pair, in a stable order. */
export function transitionPairs(): Array<[ActivationState, ActivationState]> {
  return ALL_STATES.flatMap((from) => TRANSITIONS[from].map((to): [ActivationState, ActivationState] => [from, to]));
}

/** States in which a reviewer owns the decision. */
export const REVIEWABLE_STATES: readonly ActivationState[] = ["in_review", "disputed"];

/** States in which the agent may withdraw the activation. */
export const WITHDRAWABLE_STATES: readonly ActivationState[] = ALL_STATES.filter((state) =>
  TRANSITIONS[state].includes("withdrawn"),
);

const LABELS: Record<ActivationState, string> = {
  submitted: "Submitted",
  scored_t0: "Scored at submission",
  held: "Held",
  scored_t7: "Scored at hold-close",
  in_review: "In review",
  awaiting_evidence: "Awaiting evidence",
  approved: "Approved",
  refused: "Refused",
  disputed: "Disputed",
  withdrawn: "Withdrawn",
};

export function stateLabel(state: ActivationState): string {
  return LABELS[state];
}

/** CSS chip variant for a state (see .chip in globals.css). */
export function stateChipClass(state: ActivationState): string {
  if (state === "in_review") return "review";
  if (state === "held" || state === "scored_t0" || state === "scored_t7" || state === "submitted") return "held";
  if (state === "awaiting_evidence") return "evidence";
  if (state === "approved") return "approved";
  if (state === "refused") return "refused";
  if (state === "disputed") return "disputed";
  return "neutral";
}
