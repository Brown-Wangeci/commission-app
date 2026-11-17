import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { requirePageRole } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { jobTerms } from "@/lib/jobs/jobs";
import { canAssign, whyNotAssignable } from "@/lib/jobs/assignable";
import { AssignRowAction } from "@/components/AssignRowAction";
import { EmptyState } from "@/components/EmptyState";
import { Money } from "@/components/Money";

export const metadata: Metadata = { title: "Jobs | Ledgerfield" };

type Show = "needing" | "all";

/** Every job with how many agents it has, and the Assign action for the ones that still take one. */
export default async function AdminJobsPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  await requirePageRole("admin");
  const show: Show = (await searchParams).show === "all" ? "all" : "needing";
  const [jobs, agents] = await Promise.all([
    prisma.job.findMany({ include: { client: true, _count: { select: { assignments: true } } }, orderBy: { createdAt: "desc" } }),
    prisma.agent.findMany({ include: { user: true }, orderBy: { user: { name: "asc" } } }),
  ]);
  const now = new Date();
  const rows = jobs.map((job) => ({ job, assigned: job._count.assignments, assignable: canAssign(job, job._count.assignments, now) }));
  const needing = rows.filter((row) => row.assignable);
  const shown = show === "needing" ? needing : rows;
  const options = agents.map((a) => ({ id: a.id, label: `${a.user.name} (${a.homeAreaName})` }));
  return (
    <main className="page">
      <div className="page-header">
        <div>
          <h1>Jobs</h1>
          <p className="muted small">Jobs clients have posted. Assigning an agent reserves one commission from the job&rsquo;s locked escrow, and the agent can then accept it.</p>
        </div>
      </div>
      <nav className="tabs" aria-label="Jobs">
        <Link href="/admin/jobs" className={`tab${show === "needing" ? " active" : ""}`}>Needing an agent ({needing.length})</Link>
        <Link href="/admin/jobs?show=all" className={`tab${show === "all" ? " active" : ""}`}>All jobs ({rows.length})</Link>
      </nav>
      <div className="card">
        {shown.length === 0 ? (
          show === "needing" ? (
            <EmptyState title="No job is waiting for an agent" next="A client posts a job; then a reviewer assigns agents here." action={rows.length > 0 ? { href: "/admin/jobs?show=all", label: "Show all jobs" } : undefined}>
              Jobs with a free slot appear here as soon as a client publishes them.
            </EmptyState>
          ) : (
            <EmptyState title="No jobs have been posted" next="A client business posts the first job; then a reviewer assigns agents here.">
              Every job a client publishes appears here with its slots and its commission.
            </EmptyState>
          )
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Job</th><th className="right">Agents</th><th className="right">Per approved submission</th><th>Deadline</th><th></th></tr>
              </thead>
              <tbody>
                {shown.map(({ job, assigned, assignable }) => (
                  <tr key={job.id}>
                    <td>
                      <Link href={`/admin/jobs/${job.id}`} className="strong">{job.title}</Link>
                      {job.status === "closed" && <span className="chip neutral" style={{ marginLeft: 8 }}>Closed</span>}
                      <div className="tiny muted">{job.client.name} &middot; {job.areaName}, within {job.areaRadiusM} m</div>
                    </td>
                    <td className="right num" style={{ whiteSpace: "nowrap" }}>{assigned} / {job.slots}</td>
                    <td className="right small"><Money cents={jobTerms(job).commission.amountCents} derivation={jobTerms(job).commission.derivation} /></td>
                    <td className="small num" style={{ whiteSpace: "nowrap" }}>{job.deadlineAt ? formatDateTime(job.deadlineAt) : <span className="muted">None</span>}</td>
                    <td className="right">
                      {assignable ? <AssignRowAction jobId={job.id} jobTitle={job.title} agents={options} /> : <span className="tiny muted">{whyNotAssignable(job, assigned, now)}</span>}
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
