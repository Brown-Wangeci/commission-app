import Link from "next/link";
import { prisma } from "@/lib/db";
import { clientEscrowView } from "@/lib/jobs/jobs";
import { Money } from "@/components/Money";

/** Every client business with its escrow balance and its jobs' escrow position. */
export default async function ClientsPage() {
  const clients = await prisma.clientBusiness.findMany({
    include: { user: true, jobs: { include: { _count: { select: { assignments: true, activations: true } } } } },
    orderBy: { name: "asc" },
  });
  const views = new Map(await Promise.all(clients.map(async (client) => [client.id, await clientEscrowView(client.id)] as const)));
  return (
    <main className="page">
      <div className="page-header">
        <div>
          <h1>Clients</h1>
          <p className="muted small">Client businesses, their escrow, and their jobs. Open a job to assign it to an agent.</p>
        </div>
      </div>
      {clients.length === 0 && <div className="card empty">No client businesses have signed up.</div>}
      <div className="stack-lg">
        {clients.map((client) => {
          const view = views.get(client.id)!;
          const counts = new Map(client.jobs.map((job) => [job.id, job._count]));
          return (
            <section key={client.id} className="card">
              <div className="card-pad row-between wrap" style={{ gap: 16 }}>
                <div>
                  <h2>{client.name}</h2>
                  <p className="small muted">{client.user.name} &middot; {client.user.email}</p>
                </div>
                <div className="right small">
                  <div className="stat-label">Available escrow</div>
                  <Money cents={view.availableCents} derivation={view.availableDerivation} />
                </div>
              </div>
              {view.jobs.length === 0 ? <div className="empty">No jobs posted.</div> : (
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Job</th><th className="right">Per approved submission</th><th className="right">Assigned</th><th className="right">Activations</th><th className="right">Locked</th><th className="right">Unspent</th></tr></thead>
                    <tbody>
                      {view.jobs.map(({ job, terms, escrow, unspentDerivation }) => (
                        <tr key={job.id}>
                          <td>
                            <Link href={`/admin/jobs/${job.id}`} className="strong">{job.title}</Link>
                            {job.status === "closed" && <span className="chip neutral" style={{ marginLeft: 8 }}>Closed</span>}
                            <div className="tiny muted">{job.areaName}, within {job.areaRadiusM} m</div>
                          </td>
                          <td className="right small"><Money cents={terms.commission.amountCents} derivation={terms.commission.derivation} /></td>
                          <td className="right num">{counts.get(job.id)?.assignments ?? 0} / {job.slots}</td>
                          <td className="right num">{counts.get(job.id)?.activations ?? 0}</td>
                          <td className="right small"><Money cents={escrow.lockedCents} derivation={escrow.lockedCents === terms.liability.amountCents ? terms.liability.derivation : null} /></td>
                          <td className="right small"><Money cents={escrow.unspentCents} derivation={unspentDerivation} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </main>
  );
}
