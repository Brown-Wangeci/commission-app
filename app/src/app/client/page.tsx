import Link from "next/link";
import { clientFor } from "@/lib/auth/actors";
import { requirePageRole } from "@/lib/auth/session";
import { clientJobs } from "@/lib/jobs/jobs";
import { Money, MoneyStat } from "@/components/Money";
import { FundForm } from "@/components/client/FundForm";

/** The client's escrow balance, and each job's commission, lock and outcomes. */
export default async function ClientHomePage() {
  const user = await requirePageRole("client");
  const client = await clientFor(user);
  const escrow = await clientJobs(client.id);
  return (
    <main className="page">
      <div className="page-header">
        <div>
          <h1>Jobs</h1>
          <p className="muted small">
            {client.name}. Publishing a job locks its maximum liability from your escrow; money is released only for approved
            activations, and closing a job returns what it did not spend.
          </p>
        </div>
        <Link className="btn primary" href="/client/jobs/new">Post a job</Link>
      </div>
      <div className="grid-3" style={{ marginBottom: 16 }}>
        <MoneyStat label="Deposited" cents={escrow.depositedCents} />
        <MoneyStat label="Committed to jobs" cents={escrow.committedCents} />
        <MoneyStat label="Available" cents={escrow.availableCents} derivation={escrow.availableDerivation} />
      </div>
      <section className="card card-pad" style={{ marginBottom: 16 }}>
        <FundForm />
      </section>
      <div className="card">
        {escrow.jobs.length === 0 ? (
          <div className="empty">No jobs yet. Post one to start.</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Job</th><th className="right">Per approved submission</th><th className="right">Locked</th><th className="right">Released</th><th className="right">Unspent</th><th className="right">Slots used</th><th>Outcomes</th></tr></thead>
              <tbody>
                {escrow.jobs.map(({ job, terms, escrow: jobEscrow, unspentDerivation, slotsUsed, outcomes }) => (
                  <tr key={job.id}>
                    <td>
                      <Link href={`/client/jobs/${job.id}`} className="strong">{job.title}</Link>
                      {job.status === "closed" && <span className="chip neutral" style={{ marginLeft: 8 }}>Closed</span>}
                      <div className="tiny muted">{job.areaName}, within {job.areaRadiusM} m</div>
                    </td>
                    <td className="right small"><Money cents={terms.commission.amountCents} derivation={terms.commission.derivation} /></td>
                    <td className="right small"><Money cents={jobEscrow.lockedCents} derivation={jobEscrow.lockedCents === terms.liability.amountCents ? terms.liability.derivation : null} /></td>
                    <td className="right small"><Money cents={jobEscrow.releasedCents} /></td>
                    <td className="right small"><Money cents={jobEscrow.unspentCents} derivation={unspentDerivation} /></td>
                    <td className="right num">{slotsUsed} / {job.slots}</td>
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
