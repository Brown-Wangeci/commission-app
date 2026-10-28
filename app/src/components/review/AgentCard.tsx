import Link from "next/link";
import type { AgentStats } from "@/lib/agents/history";
import { formatDate, formatPercent, initials } from "@/lib/format";

type Props = { agent: { id: string; name: string; registeredAt: Date; homeAreaName: string; stats: AgentStats } };

/** The agent's record, computed from their own submissions. */
export function AgentCard({ agent }: Props) {
  const { stats } = agent;
  return (
    <section className="card card-pad agent-card" aria-labelledby="agent-heading">
      <div className="agent-top">
        <span className="avatar lg" aria-hidden="true">{initials(agent.name)}</span>
        <div>
          <h2 id="agent-heading">{agent.name}</h2>
          <p className="small muted">Agent since {formatDate(agent.registeredAt)} &middot; based in {agent.homeAreaName}</p>
        </div>
      </div>
      <hr className="divider" />
      <div className="row-between" style={{ alignItems: "flex-end" }}>
        <div>
          <div className="stat-label">Approval rate</div>
          <div className="agent-rate">{stats.approvalRate === null ? "Unavailable" : formatPercent(stats.approvalRate)}</div>
          {stats.approvalRate === null && <div className="tiny muted">No decided submissions yet</div>}
        </div>
        <div className="right">
          <div className="stat-label">Submissions</div>
          <div className="agent-rate">{stats.total}</div>
        </div>
      </div>
      <p className="agent-breakdown" style={{ marginTop: 8 }}>
        {stats.approved} approved &middot; {stats.rejected} rejected &middot; {stats.withdrawn} withdrawn
        {stats.pending > 0 && <> &middot; {stats.pending} pending</>}
      </p>
      <p className="tiny muted" style={{ marginTop: 4 }}>
        Approval rate counts approved out of approved plus rejected; withdrawn and pending submissions are left out.
      </p>
      <Link href={`/admin/agents/${agent.id}`} className="small" style={{ display: "inline-block", marginTop: 10 }}>
        View full history
      </Link>
    </section>
  );
}
