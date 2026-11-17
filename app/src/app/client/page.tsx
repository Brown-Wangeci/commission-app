import Link from "next/link";
import { clientFor } from "@/lib/auth/actors";
import { requirePageRole } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { clientJobs } from "@/lib/jobs/jobs";
import { listFundingAttempts } from "@/lib/payments/funding";
import { Disclosure } from "@/components/Disclosure";
import { EmptyState } from "@/components/EmptyState";
import { Money, MoneyStat } from "@/components/Money";
import { FundForm } from "@/components/client/FundForm";
import { FundingList } from "@/components/client/FundingList";

type Jobs = Awaited<ReturnType<typeof clientJobs>>["jobs"];
type Row = Jobs[number];

function progressOf(outcomes: Row["outcomes"]): { approved: number; refused: number; inProgress: number } {
  const done = ["approved", "refused", "disputed", "withdrawn"];
  return {
    approved: outcomes.approved ?? 0,
    refused: (outcomes.refused ?? 0) + (outcomes.disputed ?? 0),
    inProgress: Object.entries(outcomes).filter(([state]) => !done.includes(state)).reduce((sum, [, n]) => sum + n, 0),
  };
}

function JobsTable({ rows }: { rows: Jobs }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Job</th><th className="right">Agents</th><th>Outcomes</th><th className="right">Per approved submission</th><th className="right">Locked</th><th className="right">Released</th><th className="right">Unspent</th></tr></thead>
        <tbody>
          {rows.map(({ job, terms, escrow: jobEscrow, unspentDerivation, slotsUsed, outcomes }) => {
            const progress = progressOf(outcomes);
            return (
              <tr key={job.id}>
                <td>
                  <Link href={`/client/jobs/${job.id}`} className="strong">{job.title}</Link>
                  {job.status === "closed" && <span className="chip neutral" style={{ marginLeft: 8 }}>Closed</span>}
                  <div className="tiny muted">{job.areaName}, within {job.areaRadiusM} m</div>
                  {job.status === "open" && slotsUsed === 0 && <div className="tiny" style={{ color: "var(--warn)" }}>Waiting for a reviewer to assign agents</div>}
                </td>
                <td className="right num" style={{ whiteSpace: "nowrap" }}>{slotsUsed} / {job.slots}</td>
                <td className="small">{progress.approved} approved &middot; {progress.refused} refused &middot; {progress.inProgress} in progress</td>
                <td className="right small"><Money cents={terms.commission.amountCents} derivation={terms.commission.derivation} /></td>
                <td className="right small"><Money cents={jobEscrow.lockedCents} derivation={jobEscrow.lockedCents === terms.liability.amountCents ? terms.liability.derivation : null} /></td>
                <td className="right small"><Money cents={jobEscrow.releasedCents} /></td>
                <td className="right small"><Money cents={jobEscrow.unspentCents} derivation={unspentDerivation} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** One line saying what the client should do next, or null when there is nothing to do. */
function nextStep(input: { availableCents: number; jobCount: number; waitingForAgents: number; fundingOpen: boolean }): { text: string; href?: string; action?: string } | null {
  if (input.fundingOpen) return { text: "A funding payment is waiting for M-Pesa. Enter your PIN if your phone is prompting you; your balance updates when M-Pesa confirms." };
  if (input.availableCents === 0 && input.jobCount === 0) return { text: "Fund your escrow, then post your first job. Publishing a job locks its cost from your balance.", href: "#fund", action: "Fund your escrow" };
  if (input.jobCount === 0) return { text: "You have funds. Post your first job.", href: "/client/jobs/new", action: "Post a job" };
  if (input.waitingForAgents > 0) return { text: `${input.waitingForAgents} of your jobs ${input.waitingForAgents === 1 ? "is" : "are"} waiting for a reviewer to assign agents. Nothing is needed from you.` };
  return null;
}

/** The client's jobs first, then the escrow behind them and the way to add to it. */
export default async function ClientHomePage() {
  const user = await requirePageRole("client");
  const client = await clientFor(user);
  const escrow = await clientJobs(client.id);
  const fundingAttempts = await listFundingAttempts(prisma, client.id);
  const open = escrow.jobs.filter((row) => row.job.status === "open");
  const closed = escrow.jobs.filter((row) => row.job.status !== "open");
  const fundingOpen = fundingAttempts.some((row) => row.status !== "confirmed" && row.status !== "failed");
  const step = nextStep({
    availableCents: escrow.availableCents,
    jobCount: escrow.jobs.length,
    waitingForAgents: open.filter((row) => row.slotsUsed === 0).length,
    fundingOpen,
  });
  return (
    <main className="page">
      <div className="page-header">
        <div>
          <h1>Jobs</h1>
          <p className="muted small">{client.name}. Money is released only for approved activations, and closing a job returns what it did not spend.</p>
        </div>
        <Link className="btn primary" href="/client/jobs/new">Post a job</Link>
      </div>
      {step && (
        <div className="callout calm" style={{ marginBottom: 16 }}>
          <div className="row-between wrap">
            <p className="small">{step.text}</p>
            {step.href && step.action && <a className="btn small" href={step.href}>{step.action}</a>}
          </div>
        </div>
      )}
      <section className="card" aria-labelledby="open-jobs-heading" style={{ marginBottom: 16 }}>
        <div className="card-pad"><h2 id="open-jobs-heading">Open jobs ({open.length})</h2></div>
        {open.length === 0 ? (
          <EmptyState title="No open jobs" next="You post a job; then a reviewer assigns agents to it." action={{ href: "/client/jobs/new", label: "Post a job" }}>
            Each job you publish appears here with its agents, its outcomes and the escrow behind it.
          </EmptyState>
        ) : <JobsTable rows={open} />}
      </section>
      {closed.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Disclosure id="closed-jobs" title={`Closed jobs (${closed.length})`} hint="Finished, with their unspent escrow returned">
            <JobsTable rows={closed} />
          </Disclosure>
        </div>
      )}
      <section aria-labelledby="escrow-heading" id="fund" className="stack">
        <h2 id="escrow-heading">Your escrow</h2>
        <div className="grid-3">
          <MoneyStat label="Deposited" cents={escrow.depositedCents} />
          <MoneyStat label="Committed to jobs" cents={escrow.committedCents} />
          <MoneyStat label="Available" cents={escrow.availableCents} derivation={escrow.availableDerivation} />
        </div>
        <Disclosure id="fund-escrow" title="Fund your escrow" hint="Pay by M-Pesa; see every funding attempt" defaultOpen={escrow.availableCents === 0 || fundingOpen}>
          <div className="stack">
            <FundForm />
            <FundingList rows={fundingAttempts} />
          </div>
        </Disclosure>
      </section>
    </main>
  );
}
