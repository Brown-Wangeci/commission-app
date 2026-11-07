import type { Disbursement } from "@prisma/client";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { formatCents, sumCents } from "@/lib/money/cents";
import { DISBURSEMENT_DISPLAY, paymentAttention, type PaymentAttention } from "@/lib/payments/admin";
import { storedCommissionView } from "@/lib/payouts/commissions";
import { Money } from "@/components/Money";

function needsPerson(row: Disbursement): boolean {
  return row.status === "failed" || row.escalatedAt !== null;
}

/** State, and for anything unpaid the reason and what happens next (D2). */
function DisbursementCell({ row }: { row: Disbursement | null }) {
  if (!row) return <span className="tiny muted">Authorised before M-Pesa payouts existed. Not sent.</span>;
  const display = DISBURSEMENT_DISPLAY[row.status];
  const waiting = row.status === "queued" && row.sendCount > 0;
  return (
    <>
      <span className={`chip ${display.chip}`}>{display.label}</span>
      {row.receipt && <div className="tiny muted mono">{row.receipt}</div>}
      {row.status !== "paid" && <div className="tiny">{row.failureReason ?? row.lastError ?? display.detail}</div>}
      {waiting && <div className="tiny muted">Try {row.sendCount} failed. Next try {formatDateTime(row.nextAttemptAt)}.</div>}
    </>
  );
}

function AttentionCard({ attention, stuck }: { attention: PaymentAttention; stuck: number }) {
  const { funding, callbacks } = attention;
  if (stuck + funding.length + callbacks.length === 0) return null;
  return (
    <section className="card card-pad" style={{ marginBottom: 16 }} aria-labelledby="attention-heading">
      <h2 id="attention-heading" className="strong">Needs attention</h2>
      {stuck > 0 && <p className="small">{stuck} payout{stuck === 1 ? "" : "s"} did not complete. Each one is listed below with its reason.</p>}
      {funding.map((row) => (
        <p className="small" key={row.id}>{row.client.name}: {formatCents(row.amountCents)} funding. {row.failureReason ?? row.lastError}</p>
      ))}
      {callbacks.map((row) => (
        <p className="small" key={row.id}>
          Callback on {formatDateTime(row.lastReceivedAt)}{row.deliveries > 1 ? `, delivered ${row.deliveries} times` : ""}: {row.note ?? row.outcome}
        </p>
      ))}
    </section>
  );
}

/**
 * Every authorised payout with the state of its M-Pesa disbursement. Each pays
 * its activation's commission, computed at approval and recorded with its
 * derivation. Payouts that did not complete are raised at the top.
 */
export default async function PayoutsPage() {
  const payouts = await prisma.payoutAuthorisation.findMany({
    orderBy: { authorisedAt: "desc" },
    include: { commission: true, disbursement: true, activation: { include: { agent: { include: { user: true } }, job: { include: { client: true } } } } },
  });
  const approvedWithout = await prisma.activation.count({ where: { state: "approved", payout: null } });
  const attention = await paymentAttention(prisma);
  const stuck = payouts.filter((payout) => payout.disbursement && needsPerson(payout.disbursement));
  const paid = payouts.filter((payout) => payout.disbursement?.status === "paid");
  const total = sumCents(paid.map((payout) => payout.amountCents));
  const ordered = [...stuck, ...payouts.filter((payout) => !stuck.includes(payout))];
  const deciders = new Map(
    (await prisma.user.findMany({ where: { id: { in: payouts.flatMap((p) => (p.authorisedById ? [p.authorisedById] : [])) } } })).map((u) => [u.id, u.name]),
  );
  return (
    <main className="page">
      <div className="page-header">
        <div>
          <h1>Payouts</h1>
          <p className="muted small">
            {payouts.length} authorised, {paid.length} paid by M-Pesa ({formatCents(total)}).
          </p>
        </div>
      </div>
      {approvedWithout > 0 && (
        <div className="alert warn" style={{ marginBottom: 16 }}>
          {approvedWithout} approved activation{approvedWithout === 1 ? " has" : "s have"} no payout authorisation recorded.
        </div>
      )}
      <AttentionCard attention={attention} stuck={stuck.length} />
      <div className="card">
        {payouts.length === 0 ? <div className="empty">No payouts have been authorised yet.</div> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Activation</th><th>Agent</th><th>Pays to</th><th className="right">Commission</th><th>Authorised</th><th>By</th><th>M-Pesa</th></tr></thead>
              <tbody>
                {ordered.map((payout) => (
                  <tr key={payout.id}>
                    <td><Link href={`/admin/review/${payout.activationId}`} className="mono">{payout.activation.reference}</Link><div className="tiny muted">{payout.activation.job.title}</div></td>
                    <td className="small">{payout.activation.agent.user.name}</td>
                    <td className="mono small">{payout.payoutMsisdn}</td>
                    <td className="right small"><Money cents={payout.amountCents} derivation={storedCommissionView(payout.commission).derivation} /></td>
                    <td className="small num">{formatDateTime(payout.authorisedAt)}</td>
                    <td className="small">{payout.authorisedById ? deciders.get(payout.authorisedById) ?? "A reviewer" : "Automatic release"}</td>
                    <td className="small"><DisbursementCell row={payout.disbursement} /></td>
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
