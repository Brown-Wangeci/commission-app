import type { ActivationState } from "@prisma/client";
import type { Tx } from "@/lib/db";

/**
 * An agent's record, computed from that agent's own activations. Nothing
 * here is estimated: an approval rate with no decided activations is
 * reported as unavailable (null), not as zero or a default.
 */
export type AgentStats = {
  total: number;
  approved: number;
  /** Refused, including refusals the agent is currently disputing. */
  rejected: number;
  withdrawn: number;
  pending: number;
  /** approved / (approved + rejected), or null when nothing has been decided. */
  approvalRate: number | null;
};

const REJECTED: readonly ActivationState[] = ["refused", "disputed"];

export function statsFromCounts(counts: Partial<Record<ActivationState, number>>): AgentStats {
  const count = (state: ActivationState) => counts[state] ?? 0;
  const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
  const approved = count("approved");
  const rejected = REJECTED.reduce((sum, state) => sum + count(state), 0);
  const withdrawn = count("withdrawn");
  const decided = approved + rejected;
  return {
    total,
    approved,
    rejected,
    withdrawn,
    pending: total - approved - rejected - withdrawn,
    approvalRate: decided === 0 ? null : approved / decided,
  };
}

export async function agentStats(db: Tx, agentId: string): Promise<AgentStats> {
  const groups = await db.activation.groupBy({ by: ["state"], where: { agentId }, _count: { _all: true } });
  return statsFromCounts(Object.fromEntries(groups.map((g) => [g.state, g._count._all])));
}

/** Stats for many agents in one query. */
export async function agentStatsMany(db: Tx, agentIds: string[]): Promise<Map<string, AgentStats>> {
  const groups = await db.activation.groupBy({
    by: ["agentId", "state"],
    where: { agentId: { in: agentIds } },
    _count: { _all: true },
  });
  const byAgent = new Map<string, Partial<Record<ActivationState, number>>>();
  for (const group of groups) {
    const counts = byAgent.get(group.agentId) ?? {};
    counts[group.state] = group._count._all;
    byAgent.set(group.agentId, counts);
  }
  return new Map(agentIds.map((id) => [id, statsFromCounts(byAgent.get(id) ?? {})]));
}
