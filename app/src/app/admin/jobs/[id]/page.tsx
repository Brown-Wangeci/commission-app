import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { jobEscrow, unspentDerivation } from "@/lib/escrow/holds";
import { jobTerms } from "@/lib/jobs/jobs";
import { formatDateTime } from "@/lib/format";
import { formatCents, sumCents } from "@/lib/money/cents";
import { MoneyStat } from "@/components/Money";
import { AssignAgentForm } from "@/components/AssignAgentForm";
import { StateChip } from "@/components/review/StateChip";

/** One job from the platform's side: commission, escrow, assignments, and the control to assign an agent. */
export default async function AdminJobPage({ params }: { params: Promise<{ id: string }> }) {
  const job = await prisma.job.findUnique({
    where: { id: (await params).id },
    include: {
      client: true,
      assignments: { orderBy: { assignedAt: "desc" }, include: { agent: { include: { user: true } }, activation: true, hold: true } },
    },
  });
  if (!job) notFound();
  const [escrow, agents, holdStates] = await Promise.all([
    jobEscrow(prisma, job),
    prisma.agent.findMany({ include: { user: true }, orderBy: { user: { name: "asc" } } }),
    prisma.escrowHoldState.findMany({ where: { jobId: job.id } }),
  ]);
  const terms = jobTerms(job);
  const holdState = new Map(holdStates.map((h) => [h.assignmentId, h.state]));
  return (
    <main className="page">
      <div className="breadcrumb"><Link href="/admin/clients">&larr; Clients</Link></div>
      <div className="page-header">
        <div>
          <h1>{job.title}{job.status === "closed" && <span className="chip neutral" style={{ marginLeft: 10 }}>Closed</span>}</h1>
          <p className="muted small">{job.client.name} &middot; {job.areaName}, within {job.areaRadiusM} m &middot; {job.assignments.length} of {job.slots} slots assigned</p>
        </div>
      </div>
      <div className="grid-4" style={{ marginBottom: 16 }}>
        <MoneyStat label="Commission per approved submission" cents={terms.commission.amountCents} derivation={terms.commission.derivation} />
        <MoneyStat label="Locked at publication" cents={escrow.lockedCents} derivation={escrow.lockedCents === terms.liability.amountCents ? terms.liability.derivation : null} />
        <MoneyStat label="Reserved and held" cents={sumCents([escrow.reservedCents, escrow.heldCents])} />
        <MoneyStat label={job.status === "open" ? "Unspent" : "Returned to the client"} cents={escrow.unspentCents} derivation={unspentDerivation(escrow)} />
      </div>
      {job.status === "open" ? (
        <section className="card card-pad" style={{ marginBottom: 16 }}>
          <AssignAgentForm jobId={job.id} agents={agents.map((a) => ({ id: a.id, label: `${a.user.name} (${a.homeAreaName})` }))} />
          <p className="tiny muted" style={{ marginTop: 8 }}>
            Assigning reserves one commission ({formatCents(terms.commission.amountCents)}) from the job&rsquo;s locked escrow in a hold.
          </p>
        </section>
      ) : (
        <section className="card card-pad small muted" style={{ marginBottom: 16 }}>
          The client closed this job{job.closedAt ? ` on ${formatDateTime(job.closedAt)}` : ""}. It takes no new assignments.
        </section>
      )}
      <section className="card">
        <div className="card-pad"><h2>Assignments ({job.assignments.length})</h2></div>
        {job.assignments.length === 0 ? <div className="empty">Nobody has been assigned yet.</div> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Agent</th><th>Assigned</th><th>Accepted</th><th>Escrow hold</th><th>Activation</th></tr></thead>
              <tbody>
                {job.assignments.map((a) => (
                  <tr key={a.id}>
                    <td><Link href={`/admin/agents/${a.agentId}`}>{a.agent.user.name}</Link></td>
                    <td className="small num">{formatDateTime(a.assignedAt)}</td>
                    <td className="small num">{a.acceptedAt ? formatDateTime(a.acceptedAt) : <span className="muted">Not yet</span>}</td>
                    <td className="small">{a.hold ? `${formatCents(a.hold.amountCents)}, ${holdState.get(a.id) ?? "unknown"}` : "None"}</td>
                    <td>{a.activation ? <span className="row" style={{ gap: 8 }}><Link href={`/admin/review/${a.activation.id}`} className="mono">{a.activation.reference}</Link><StateChip state={a.activation.state} /></span> : <span className="muted small">Not submitted</span>}</td>
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
