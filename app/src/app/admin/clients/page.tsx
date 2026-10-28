import Link from "next/link";
import { prisma } from "@/lib/db";
import { escrowBalance } from "@/lib/escrow/holds";
import { formatKsh } from "@/lib/format";

/** Every client business with its jobs and their escrow position. */
export default async function ClientsPage() {
  const clients = await prisma.clientBusiness.findMany({
    include: { user: true, jobs: { orderBy: { createdAt: "desc" }, include: { _count: { select: { assignments: true, activations: true } } } } },
    orderBy: { name: "asc" },
  });
  const balances = new Map(
    await Promise.all(clients.flatMap((c) => c.jobs).map(async (job) => [job.id, await escrowBalance(prisma, job.id)] as const)),
  );
  return (
    <main className="page">
      <div className="page-header">
        <div>
          <h1>Clients</h1>
          <p className="muted small">Client businesses and their jobs. Open a job to assign it to an agent.</p>
        </div>
      </div>
      {clients.length === 0 && <div className="card empty">No client businesses have signed up.</div>}
      <div className="stack-lg">
        {clients.map((client) => (
          <section key={client.id} className="card">
            <div className="card-pad row-between">
              <div>
                <h2>{client.name}</h2>
                <p className="small muted">{client.user.name} &middot; {client.user.email}</p>
              </div>
              <span className="small muted">{client.jobs.length} job{client.jobs.length === 1 ? "" : "s"}</span>
            </div>
            {client.jobs.length === 0 ? <div className="empty">No jobs posted.</div> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Job</th><th>Area</th><th className="right">Payout</th><th className="right">Assigned</th><th className="right">Activations</th><th className="right">Funded</th><th className="right">Available</th></tr></thead>
                  <tbody>
                    {client.jobs.map((job) => {
                      const balance = balances.get(job.id)!;
                      return (
                        <tr key={job.id}>
                          <td><Link href={`/admin/jobs/${job.id}`} className="strong">{job.title}</Link>{job.status === "closed" && <span className="chip neutral" style={{ marginLeft: 8 }}>Closed</span>}</td>
                          <td className="small">{job.areaName}<div className="tiny muted">within {job.areaRadiusM} m</div></td>
                          <td className="right num">{formatKsh(job.payoutPerActivationKsh)}</td>
                          <td className="right num">{job._count.assignments} / {job.slots}</td>
                          <td className="right num">{job._count.activations}</td>
                          <td className="right num">{formatKsh(balance.fundedKsh)}</td>
                          <td className="right num">{formatKsh(balance.availableKsh)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ))}
      </div>
    </main>
  );
}
