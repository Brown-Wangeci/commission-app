import Link from "next/link";
import { prisma } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { formatCents, sumCents } from "@/lib/money/cents";
import { storedCommissionView } from "@/lib/payouts/commissions";
import { Money } from "@/components/Money";

/**
 * Payouts that have been authorised. Each pays its activation's commission,
 * computed at approval and recorded with its derivation (issue #41).
 * Authorisation is recorded through the payout boundary (issue #15); how
 * money is actually settled is outside this build (issue #14), so the status
 * shown is the authorisation record itself.
 */
export default async function PayoutsPage() {
  const payouts = await prisma.payoutAuthorisation.findMany({
    orderBy: { authorisedAt: "desc" },
    include: { commission: true, activation: { include: { agent: { include: { user: true } }, job: { include: { client: true } } } } },
  });
  const approvedWithout = await prisma.activation.count({ where: { state: "approved", payout: null } });
  const total = sumCents(payouts.map((payout) => payout.amountCents));
  const deciders = new Map(
    (await prisma.user.findMany({ where: { id: { in: payouts.flatMap((p) => (p.authorisedById ? [p.authorisedById] : [])) } } })).map((u) => [u.id, u.name]),
  );
  return (
    <main className="page">
      <div className="page-header">
        <div>
          <h1>Payouts</h1>
          <p className="muted small">
            {payouts.length} authorised, {formatCents(total)} in total. Settlement (moving the money) is not part of this build; each row is the authorisation as recorded.
          </p>
        </div>
      </div>
      {approvedWithout > 0 && (
        <div className="alert warn" style={{ marginBottom: 16 }}>
          {approvedWithout} approved activation{approvedWithout === 1 ? " has" : "s have"} no payout authorisation recorded.
        </div>
      )}
      <div className="card">
        {payouts.length === 0 ? <div className="empty">No payouts have been authorised yet.</div> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Activation</th><th>Agent</th><th>Pays to</th><th className="right">Commission</th><th>Authorised</th><th>By</th><th>Status</th></tr></thead>
              <tbody>
                {payouts.map((payout) => (
                  <tr key={payout.id}>
                    <td><Link href={`/admin/review/${payout.activationId}`} className="mono">{payout.activation.reference}</Link><div className="tiny muted">{payout.activation.job.title}</div></td>
                    <td className="small">{payout.activation.agent.user.name}</td>
                    <td className="mono small">{payout.payoutMsisdn}</td>
                    <td className="right small"><Money cents={payout.amountCents} derivation={storedCommissionView(payout.commission).derivation} /></td>
                    <td className="small num">{formatDateTime(payout.authorisedAt)}</td>
                    <td className="small">{payout.authorisedById ? deciders.get(payout.authorisedById) ?? "A reviewer" : "Automatic release"}</td>
                    <td className="small"><span className="chip approved">Authorised</span><div className="tiny muted">via {payout.provider}{payout.providerRef ? ` (${payout.providerRef})` : ""}</div></td>
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
