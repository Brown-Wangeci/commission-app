import Link from "next/link";
import { agentFor } from "@/lib/auth/actors";
import { requirePageRole } from "@/lib/auth/session";
import { agentHome } from "@/lib/agents/views";
import { formatDateTime, formatKsh } from "@/lib/format";
import { ActionButton } from "@/components/ActionButton";
import { NotificationsPanel } from "@/components/NotificationsPanel";

type Assignment = Awaited<ReturnType<typeof agentHome>>["toAccept"][number];

function JobLine({ assignment }: { assignment: Assignment }) {
  const { job } = assignment;
  return (
    <div>
      <div className="strong">{job.title}</div>
      <div className="small muted">
        {job.client.name} &middot; {job.areaName} (within {job.areaRadiusM} m) &middot; pays {assignment.hold ? formatKsh(assignment.hold.amountKsh) : "amount unavailable"}
      </div>
      <div className="tiny muted">Assigned {formatDateTime(assignment.assignedAt)}</div>
    </div>
  );
}

/** The agent's home: notifications, jobs to accept, and jobs ready for an activation. */
export default async function AgentHomePage() {
  const user = await requirePageRole("agent");
  const agent = await agentFor(user);
  const { toAccept, toSubmit } = await agentHome(agent.id);
  return (
    <main className="page page-narrow">
      <div className="page-header">
        <div>
          <h1>My jobs</h1>
          <p className="muted small">Accept a job, sign the customer up, then submit the activation with your evidence.</p>
        </div>
        <Link href="/agent/activations" className="btn">My activations</Link>
      </div>
      <NotificationsPanel userId={user.id} linkBase="/agent/activations" />
      <section className="card" style={{ marginBottom: 20 }}>
        <div className="card-pad"><h2>Waiting for you to accept ({toAccept.length})</h2></div>
        {toAccept.length === 0 ? <div className="empty">No new jobs.</div> : (
          <ul className="timeline" style={{ padding: "0 20px 8px" }}>
            {toAccept.map((assignment) => (
              <li key={assignment.id} className="row-between wrap">
                <JobLine assignment={assignment} />
                <ActionButton url={`/api/agent/assignments/${assignment.id}/accept`} label="Accept job" className="btn primary small" />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card">
        <div className="card-pad"><h2>Ready to submit ({toSubmit.length})</h2></div>
        {toSubmit.length === 0 ? <div className="empty">Nothing to submit. Accepted jobs appear here.</div> : (
          <ul className="timeline" style={{ padding: "0 20px 8px" }}>
            {toSubmit.map((assignment) => (
              <li key={assignment.id} className="row-between wrap">
                <JobLine assignment={assignment} />
                <Link href={`/agent/submit/${assignment.id}`} className="btn primary small">Submit activation</Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
