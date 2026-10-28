import Link from "next/link";
import { clientFor } from "@/lib/auth/actors";
import { requirePageRole } from "@/lib/auth/session";
import { clientJobs } from "@/lib/jobs/jobs";
import { formatKsh } from "@/lib/format";

/** The client's jobs: escrow position and how many activations ended which way. */
export default async function ClientHomePage() {
  const user = await requirePageRole("client");
  const client = await clientFor(user);
  const jobs = await clientJobs(client.id);
  return (
    <main className="page">
      <div className="page-header">
        <div>
          <h1>Jobs</h1>
          <p className="muted small">{client.name}. Money for each assignment is locked in escrow and released only for approved activations.</p>
        </div>
        <Link className="btn primary" href="/client/jobs/new">Post a job</Link>
      </div>
      <div className="card">
        {jobs.length === 0 ? (
          <div className="empty">No jobs yet. Post one to start.</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Job</th><th>Area</th><th className="right">Funded</th><th className="right">Available</th><th className="right">Slots used</th><th>Outcomes</th></tr></thead>
              <tbody>
                {jobs.map(({ job, balance, outcomes }) => (
                  <tr key={job.id}>
                    <td><Link href={`/client/jobs/${job.id}`} className="strong">{job.title}</Link><div className="tiny muted">{formatKsh(job.payoutPerActivationKsh)} per activation</div></td>
                    <td className="small">{job.areaName}<div className="tiny muted">within {job.areaRadiusM} m</div></td>
                    <td className="right num">{formatKsh(balance.fundedKsh)}</td>
                    <td className="right num">{formatKsh(balance.availableKsh)}</td>
                    <td className="right num">{job._count.assignments} / {job.slots}</td>
                    <td className="small">
                      {(outcomes.approved ?? 0)} approved &middot; {(outcomes.refused ?? 0) + (outcomes.disputed ?? 0)} refused &middot;{" "}
                      {Object.entries(outcomes).filter(([state]) => !["approved", "refused", "disputed", "withdrawn"].includes(state)).reduce((sum, [, n]) => sum + n, 0)} in progress
                    </td>
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
