import Link from "next/link";
import { agentFor } from "@/lib/auth/actors";
import { requirePageRole } from "@/lib/auth/session";
import { agentHome } from "@/lib/agents/views";
import { formatDateTime } from "@/lib/format";
import { formatCents } from "@/lib/money/cents";
import { payoutAmountView } from "@/lib/payouts/amount";
import { ActionButton } from "@/components/ActionButton";
import { EmptyState } from "@/components/EmptyState";
import { NotificationsPanel } from "@/components/NotificationsPanel";

type Assignment = Awaited<ReturnType<typeof agentHome>>["toAccept"][number];

function JobLine({ assignment }: { assignment: Assignment }) {
  const { job } = assignment;
  const amount = payoutAmountView({ job, hold: assignment.hold, commission: null });
  return (
    <div>
      <div className="strong">{job.title}</div>
      <div className="small">Pays <span className="strong num">{amount ? formatCents(amount.amountCents) : "amount unavailable"}</span> once approved</div>
      <div className="small muted">{job.client.name} &middot; {job.areaName} (within {job.areaRadiusM} m)</div>
      <div className="tiny muted">Assigned {formatDateTime(assignment.assignedAt)}</div>
    </div>
  );
}

/**
 * The agent's home. What needs the agent now comes first: a job to accept,
 * then a job to submit. A list with nothing in it is not drawn as a card, and
 * if both are empty one message says what will appear and who acts next.
 * Notifications follow the jobs, and the steps of a job are one line below.
 * My activations is the second tab, so no button repeats it here.
 */
export default async function AgentHomePage() {
  const user = await requirePageRole("agent");
  const agent = await agentFor(user);
  const { toAccept, toSubmit } = await agentHome(agent.id);
  const nothingNow = toAccept.length === 0 && toSubmit.length === 0;
  return (
    <main className="page page-narrow">
      <div className="page-header">
        <div>
          <h1>My jobs</h1>
          <p className="muted small">
            {nothingNow
              ? "Nothing needs you right now."
              : toAccept.length > 0
                ? `${toAccept.length} ${toAccept.length === 1 ? "job is" : "jobs are"} waiting for you to accept.`
                : `${toSubmit.length} ${toSubmit.length === 1 ? "job is" : "jobs are"} ready for an activation.`}
          </p>
        </div>
      </div>
      {nothingNow && (
        <section className="card" style={{ marginBottom: 20 }}>
          <EmptyState title="No jobs for you right now" next="A reviewer assigns jobs to agents. You will see one here, with an Accept button, as soon as it is assigned.">
            A job you accept appears under Ready to submit, where you sign the customer up and submit it with your evidence.
          </EmptyState>
        </section>
      )}
      {toAccept.length > 0 && (
        <section className="card" style={{ marginBottom: 20 }} aria-labelledby="accept-heading">
          <div className="card-pad"><h2 id="accept-heading">Accept a job ({toAccept.length})</h2></div>
          <ul className="timeline" style={{ padding: "0 20px 8px" }}>
            {toAccept.map((assignment) => (
              <li key={assignment.id} className="row-between wrap">
                <JobLine assignment={assignment} />
                <ActionButton url={`/api/agent/assignments/${assignment.id}/accept`} label="Accept job" className="btn primary small" />
              </li>
            ))}
          </ul>
        </section>
      )}
      {toSubmit.length > 0 && (
        <section className="card" style={{ marginBottom: 20 }} aria-labelledby="submit-heading">
          <div className="card-pad"><h2 id="submit-heading">Ready to submit ({toSubmit.length})</h2></div>
          <ul className="timeline" style={{ padding: "0 20px 8px" }}>
            {toSubmit.map((assignment) => (
              <li key={assignment.id} className="row-between wrap">
                <JobLine assignment={assignment} />
                <Link href={`/agent/submit/${assignment.id}`} className={`btn small${toAccept.length === 0 ? " primary" : ""}`}>Submit activation</Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <NotificationsPanel userId={user.id} linkBase="/agent/activations" />
      <details className="disclosure">
        <summary><h2>How a job works</h2></summary>
        <div className="disclosure-body">
          <ol className="small steps">
            <li>Accept the job a reviewer assigned to you.</li>
            <li>Sign the customer up, then open Submit activation and add your evidence.</li>
            <li>A reviewer or the system decides. You are paid by M-Pesa once it is approved; follow it under My activations.</li>
          </ol>
        </div>
      </details>
    </main>
  );
}
