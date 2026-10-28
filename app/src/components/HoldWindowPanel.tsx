import Link from "next/link";
import { prisma } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { ActionButton } from "./ActionButton";

/**
 * Activations waiting for the hold window to close, with the admin controls
 * for the T7 schedule: force one now, or run everything that is due.
 */
export async function HoldWindowPanel() {
  const held = await prisma.activation.findMany({
    where: { state: "held" },
    orderBy: { holdClosesAt: "asc" },
    take: 15,
    include: { agent: { include: { user: true } }, job: true },
  });
  return (
    <section className="card">
      <div className="card-pad row-between wrap">
        <div>
          <h2>Hold window</h2>
          <p className="small muted">Held activations are scored again by the T7 model when their hold closes.</p>
        </div>
        <ActionButton url="/api/admin/scoring/run-due" label="Run due scoring now" report="run-summary" />
      </div>
      {held.length === 0 ? (
        <div className="empty">No activations are on hold.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Reference</th><th>Agent</th><th>Job</th><th>Hold closes</th><th></th></tr>
            </thead>
            <tbody>
              {held.map((activation) => (
                <tr key={activation.id}>
                  <td className="mono">{activation.reference}</td>
                  <td><Link href={`/admin/agents/${activation.agentId}`}>{activation.agent.user.name}</Link></td>
                  <td>{activation.job.title}</td>
                  <td className="num">{activation.holdClosesAt ? formatDateTime(activation.holdClosesAt) : "Not recorded"}</td>
                  <td className="right">
                    <ActionButton
                      url={`/api/admin/activations/${activation.id}/score-t7`}
                      label="Force T7 now"
                      confirm={`Score ${activation.reference} with the hold-close model now, before its hold window ends?`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
