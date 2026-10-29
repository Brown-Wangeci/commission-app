import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { agentStats } from "@/lib/agents/history";
import { formatDate, formatDateTime, formatPercent, formatProbability, initials } from "@/lib/format";
import { payoutAmountView } from "@/lib/payouts/amount";
import { Money } from "@/components/Money";
import { StateChip } from "@/components/review/StateChip";

/** One agent's full history, from their own records. */
export default async function AgentHistoryPage({ params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  const agent = await prisma.agent.findUnique({ where: { id }, include: { user: true } });
  if (!agent) notFound();
  const [stats, activations] = await Promise.all([
    agentStats(prisma, id),
    prisma.activation.findMany({
      where: { agentId: id },
      orderBy: { submittedAt: "desc" },
      include: {
        job: { include: { client: true } },
        assignment: { include: { hold: true } },
        commission: true,
        decisions: { orderBy: { recordedAt: "desc" }, take: 1 },
        reviewItems: { where: { closedAt: { not: null } }, orderBy: { closedAt: "desc" }, take: 1, include: { reviewer: true } },
      },
    }),
  ]);
  return (
    <main className="page">
      <div className="breadcrumb"><Link href="/admin/agents">&larr; Agents</Link></div>
      <div className="page-header">
        <div className="row">
          <span className="avatar lg" aria-hidden="true">{initials(agent.user.name)}</span>
          <div>
            <h1>{agent.user.name}</h1>
            <p className="muted small">
              Agent since {formatDate(agent.registeredAt)} &middot; based in {agent.homeAreaName} &middot; payout number <span className="mono">{agent.payoutMsisdn}</span>
            </p>
          </div>
        </div>
      </div>
      <div className="grid-4" style={{ marginBottom: 16 }}>
        <div className="card stat"><div className="stat-label">Approval rate</div><div className="stat-value">{stats.approvalRate === null ? "Unavailable" : formatPercent(stats.approvalRate)}</div></div>
        <div className="card stat"><div className="stat-label">Submissions</div><div className="stat-value">{stats.total}</div></div>
        <div className="card stat"><div className="stat-label">Approved / rejected</div><div className="stat-value">{stats.approved} / {stats.rejected}</div></div>
        <div className="card stat"><div className="stat-label">Withdrawn / pending</div><div className="stat-value">{stats.withdrawn} / {stats.pending}</div></div>
      </div>
      <div className="card">
        {activations.length === 0 ? (
          <div className="empty">This agent has not submitted anything yet.</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Reference</th><th>Submitted</th><th>Job</th><th>Status</th><th>Latest score</th><th>Last human decision</th><th className="right">Payout</th></tr></thead>
              <tbody>
                {activations.map((activation) => {
                  const decision = activation.decisions[0];
                  const review = activation.reviewItems[0];
                  const amount = payoutAmountView({ job: activation.job, hold: activation.assignment.hold, commission: activation.commission });
                  return (
                    <tr key={activation.id}>
                      <td><Link href={`/admin/review/${activation.id}`} className="mono">{activation.reference}</Link></td>
                      <td className="num small">{formatDateTime(activation.submittedAt)}</td>
                      <td className="small">{activation.job.title}<div className="tiny muted">{activation.job.client.name}</div></td>
                      <td><StateChip state={activation.state} /></td>
                      <td className="small">{decision ? `${formatProbability(decision.probability)} (${decision.mode.toUpperCase()}, ${decision.band.replace("_", " ")})` : <span className="muted">No score</span>}</td>
                      <td className="small">{review ? <>{review.action?.replace("_", " ")} by {review.reviewer?.name ?? "the agent"}<div className="tiny muted">{review.reason}</div></> : <span className="muted">None</span>}</td>
                      <td className="right small">{amount ? <Money cents={amount.amountCents} derivation={amount.commission.derivation} /> : "Unavailable"}</td>
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
