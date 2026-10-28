import Link from "next/link";
import { prisma } from "@/lib/db";
import { agentStatsMany } from "@/lib/agents/history";
import { formatDate, formatPercent } from "@/lib/format";

/** Every agent with their approval record, computed from their own activations. */
export default async function AgentsPage() {
  const agents = await prisma.agent.findMany({ include: { user: true }, orderBy: { user: { name: "asc" } } });
  const stats = await agentStatsMany(prisma, agents.map((agent) => agent.id));
  return (
    <main className="page">
      <div className="page-header">
        <div>
          <h1>Agents</h1>
          <p className="muted small">Approval rate is approved out of approved plus rejected. Open an agent for their full history.</p>
        </div>
      </div>
      <div className="card">
        {agents.length === 0 ? <div className="empty">No agents have signed up.</div> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Agent</th><th>Based in</th><th>Agent since</th><th className="right">Submissions</th><th className="right">Approved</th><th className="right">Rejected</th><th className="right">Withdrawn</th><th className="right">Pending</th><th className="right">Approval rate</th></tr></thead>
              <tbody>
                {agents.map((agent) => {
                  const s = stats.get(agent.id)!;
                  return (
                    <tr key={agent.id}>
                      <td><Link href={`/admin/agents/${agent.id}`} className="strong">{agent.user.name}</Link><div className="tiny muted">{agent.user.email}</div></td>
                      <td className="small">{agent.homeAreaName}</td>
                      <td className="small">{formatDate(agent.registeredAt)}</td>
                      <td className="right num">{s.total}</td>
                      <td className="right num">{s.approved}</td>
                      <td className="right num">{s.rejected}</td>
                      <td className="right num">{s.withdrawn}</td>
                      <td className="right num">{s.pending}</td>
                      <td className="right num strong">{s.approvalRate === null ? <span className="muted">Unavailable</span> : formatPercent(s.approvalRate)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
