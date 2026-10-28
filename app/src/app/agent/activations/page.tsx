import Link from "next/link";
import { agentFor } from "@/lib/auth/actors";
import { requirePageRole } from "@/lib/auth/session";
import { agentActivations } from "@/lib/agents/views";
import { formatDateTime, formatKsh } from "@/lib/format";
import { StateChip } from "@/components/review/StateChip";

/** Every activation the agent has submitted, with its status and the reason for it. */
export default async function AgentActivationsPage() {
  const agent = await agentFor(await requirePageRole("agent"));
  const rows = await agentActivations(agent.id);
  return (
    <main className="page">
      <div className="page-header">
        <div>
          <h1>My activations</h1>
          <p className="muted small">Newest first. Open one to see its full history, answer a reviewer, or contest a refusal.</p>
        </div>
      </div>
      <div className="card">
        {rows.length === 0 ? (
          <div className="empty">You have not submitted any activations yet.</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Reference</th><th>Job</th><th>Submitted</th><th>Status</th><th>Why</th><th className="right">Payout</th></tr></thead>
              <tbody>
                {rows.map(({ activation, explanation }) => (
                  <tr key={activation.id}>
                    <td><Link href={`/agent/activations/${activation.id}`} className="mono">{activation.reference}</Link></td>
                    <td className="small">{activation.job.title}<div className="tiny muted">{activation.job.client.name}</div></td>
                    <td className="small num">{formatDateTime(activation.submittedAt)}</td>
                    <td><StateChip state={activation.state} /></td>
                    <td className="small" style={{ maxWidth: 420 }}>
                      <strong>{explanation.headline}.</strong> {explanation.detail}
                    </td>
                    <td className="right num small">{activation.assignment.hold ? formatKsh(activation.assignment.hold.amountKsh) : "Unavailable"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
