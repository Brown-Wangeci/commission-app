import type { ActivationState } from "@prisma/client";
import type { Tx } from "@/lib/db";
import { ALL_STATES, REVIEWABLE_STATES } from "@/lib/activations/states";
import { paymentAttention } from "@/lib/payments/admin";

/**
 * What the reviewer's dashboard shows: the state counts grouped by who has to
 * act, and the things that need a person right now. Reads only; no
 * decision, score or payment is made here.
 */
export type StateGroupId = "in_progress" | "needs_person" | "done";

export const STATE_GROUPS: ReadonlyArray<{ id: StateGroupId; label: string; note: string; states: readonly ActivationState[] }> = [
  {
    id: "in_progress",
    label: "In progress",
    note: "Moving through the system. Nobody needs to act.",
    states: ["submitted", "scored_t0", "held", "scored_t7", "awaiting_evidence"],
  },
  {
    id: "needs_person",
    label: "Needs a person",
    note: "A reviewer owns the decision.",
    states: REVIEWABLE_STATES,
  },
  {
    id: "done",
    label: "Done",
    note: "Decided. A refusal can still be contested once.",
    states: ["approved", "refused", "withdrawn"],
  },
];

export type GroupTotals = Array<{ id: StateGroupId; label: string; note: string; total: number; states: Array<{ state: ActivationState; count: number }> }>;

export function groupCounts(counts: ReadonlyMap<ActivationState, number>): GroupTotals {
  return STATE_GROUPS.map((group) => {
    const states = group.states.map((state) => ({ state, count: counts.get(state) ?? 0 }));
    return { id: group.id, label: group.label, note: group.note, total: states.reduce((sum, row) => sum + row.count, 0), states };
  });
}

export function everyStateIsGrouped(): boolean {
  const grouped = STATE_GROUPS.flatMap((group) => group.states);
  return grouped.length === ALL_STATES.length && ALL_STATES.every((state) => grouped.includes(state));
}

export type AttentionItem = {
  id: "decisions" | "unscored" | "payouts" | "jobs";
  count: number;
  label: string;
  detail: string;
  href: string;
  action: string;
};

export type Attention = { items: AttentionItem[]; total: number };

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Orders items so those with something to do come first, keeping the fixed order within each half. */
export function ordered(items: AttentionItem[]): AttentionItem[] {
  return [...items.filter((item) => item.count > 0), ...items.filter((item) => item.count === 0)];
}

export async function attention(db: Tx): Promise<Attention> {
  const [awaiting, disputed, unscored, payouts, payment, unassigned] = await Promise.all([
    db.activation.count({ where: { state: { in: [...REVIEWABLE_STATES] } } }),
    db.activation.count({ where: { state: "disputed" } }),
    db.activation.count({ where: { unscoredStage: { not: null } } }),
    db.disbursement.count({ where: { status: { in: ["failed", "unconfirmed"] } } }),
    paymentAttention(db),
    db.job.count({ where: { status: "open", assignments: { none: {} } } }),
  ]);
  const funding = payment.funding.length;
  const items: AttentionItem[] = [
    {
      id: "decisions",
      count: awaiting,
      label: `${plural(awaiting, "submission", "submissions")} awaiting your decision`,
      detail: disputed > 0 ? `${disputed} of them ${disputed === 1 ? "is a refusal the agent contested" : "are refusals the agent contested"}. Oldest first.` : "Oldest first.",
      href: "/admin/review",
      action: "Open the review queue",
    },
    {
      id: "unscored",
      count: unscored,
      label: `${plural(unscored, "submission", "submissions")} could not be scored`,
      detail: "Each has no model score, so it was sent to a person. Decide on the evidence.",
      href: "/admin/review",
      action: "Open the review queue",
    },
    {
      id: "payouts",
      count: payouts + funding,
      label:
        funding > 0
          ? `${plural(payouts, "payout", "payouts")} failed or unconfirmed, ${plural(funding, "funding attempt", "funding attempts")} raised`
          : `${plural(payouts, "payout", "payouts")} failed or unconfirmed`,
      detail: "M-Pesa did not confirm these. The escrow stays held until it does.",
      href: "/admin/payouts",
      action: "Open payouts",
    },
    {
      id: "jobs",
      count: unassigned,
      label: `${plural(unassigned, "job", "jobs")} waiting for an agent`,
      detail: "A client posted these and no agent has been assigned yet.",
      href: "/admin/jobs",
      action: "Open jobs",
    },
  ];
  return { items: ordered(items), total: items.reduce((sum, item) => sum + item.count, 0) };
}
