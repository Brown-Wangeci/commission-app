import Link from "next/link";
import { notFound } from "next/navigation";
import { clientFor } from "@/lib/auth/actors";
import { requirePageRole } from "@/lib/auth/session";
import { clientJob } from "@/lib/jobs/jobs";
import { ApiError } from "@/lib/http/errors";
import { isFinal } from "@/lib/activations/states";
import { formatDateTime, formatKsh } from "@/lib/format";
import { StateChip } from "@/components/review/StateChip";
import { FundForm } from "@/components/client/FundForm";

/** One job: escrow, deposits, and the outcome of every activation with its reason. */
export default async function ClientJobPage({ params }: { params: Promise<{ id: string }> }) {
  const client = await clientFor(await requirePageRole("client"));
  const detail = await clientJob(client.id, (await params).id).catch((error) => {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  });
  const { job, balance, activations, deposits } = detail;
  return (
    <main className="page">
      <div className="breadcrumb"><Link href="/client">&larr; Jobs</Link></div>
      <div className="page-header">
        <div>
          <h1>{job.title}</h1>
          <p className="muted small">
            {job.areaName}, within {job.areaRadiusM} m of {job.areaLat.toFixed(4)}, {job.areaLon.toFixed(4)} &middot; {formatKsh(job.payoutPerActivationKsh)} per activation &middot;{" "}
            {(job.commissionRate * 100).toFixed(1)}% commission &middot; {job.slots} activations wanted
          </p>
        </div>
      </div>
      <div className="grid-4" style={{ marginBottom: 16 }}>
        <div className="card stat"><div className="stat-label">Funded</div><div className="stat-value">{formatKsh(balance.fundedKsh)}</div></div>
        <div className="card stat"><div className="stat-label">Locked (reserved and held)</div><div className="stat-value">{formatKsh(balance.reservedKsh + balance.heldKsh)}</div></div>
        <div className="card stat"><div className="stat-label">Released to agents</div><div className="stat-value">{formatKsh(balance.releasedKsh)}</div></div>
        <div className="card stat"><div className="stat-label">Available</div><div className="stat-value">{formatKsh(balance.availableKsh)}</div></div>
      </div>
      <section className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="row-between wrap" style={{ alignItems: "flex-end" }}>
          <FundForm jobId={job.id} suggestedKsh={job.payoutPerActivationKsh * 5} />
          <p className="tiny muted">{deposits.length} deposit{deposits.length === 1 ? "" : "s"} so far{deposits[0] ? `, latest ${formatDateTime(deposits[0].createdAt)}` : ""}. Refused or withdrawn activations return their payout to the available balance.</p>
        </div>
      </section>
      <section className="card">
        <div className="card-pad"><h2>Activations on this job ({activations.length})</h2></div>
        {activations.length === 0 ? <div className="empty">No activations yet.</div> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Reference</th><th>Agent</th><th>Submitted</th><th>Outcome</th><th>Reason</th><th>First-week activity</th></tr></thead>
              <tbody>
                {activations.map(({ activation, explanation }) => (
                  <tr key={activation.id}>
                    <td className="mono">{activation.reference}</td>
                    <td className="small">{activation.agent.user.name}</td>
                    <td className="small num">{formatDateTime(activation.submittedAt)}</td>
                    <td><StateChip state={activation.state} /></td>
                    <td className="small" style={{ maxWidth: 420 }}><strong>{explanation.headline}.</strong> {explanation.detail}</td>
                    <td className="small">
                      {activation._count.activity} of 8 days reported
                      {!isFinal(activation.state) && (
                        <div><Link href={`/client/activations/${activation.id}/activity`}>{activation._count.activity === 0 ? "Report activity" : "Update"}</Link></div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
