import Link from "next/link";
import { prisma } from "@/lib/db";
import { stateLabel } from "@/lib/activations/states";
import { formatDateTime } from "@/lib/format";

const PAGE_SIZE = 100;

/**
 * Every recorded event, newest first: state transitions (written by the
 * database trigger, so none can be missed) and the other actions the app
 * records (scores, failures, assignments, deposits, evidence, disputes).
 */
export default async function AuditPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const page = Math.max(1, Number.parseInt((await searchParams).page ?? "1", 10) || 1);
  const [events, total] = await Promise.all([
    prisma.auditEvent.findMany({ orderBy: [{ at: "desc" }, { id: "desc" }], skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
    prisma.auditEvent.count(),
  ]);
  const activationIds = [...new Set(events.flatMap((e) => (e.activationId ? [e.activationId] : [])))];
  const actorIds = [...new Set(events.flatMap((e) => (e.actorId ? [e.actorId] : [])))];
  const [activations, actors] = await Promise.all([
    prisma.activation.findMany({ where: { id: { in: activationIds } }, select: { id: true, reference: true } }),
    prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, role: true } }),
  ]);
  const refs = new Map(activations.map((a) => [a.id, a.reference]));
  const names = new Map(actors.map((u) => [u.id, `${u.name} (${u.role})`]));
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <main className="page">
      <div className="page-header">
        <div>
          <h1>Audit log</h1>
          <p className="muted small">{total} events, newest first. State changes are written by the database itself.</p>
        </div>
        <div className="row">
          {page > 1 && <Link className="btn small" href={`/admin/audit?page=${page - 1}`}>Newer</Link>}
          <span className="small muted">Page {page} of {pages}</span>
          {page < pages && <Link className="btn small" href={`/admin/audit?page=${page + 1}`}>Older</Link>}
        </div>
      </div>
      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>When</th><th>Event</th><th>Activation</th><th>Who</th><th>Detail</th></tr></thead>
            <tbody>
              {events.map((event) => (
                <tr key={String(event.id)}>
                  <td className="small num" style={{ whiteSpace: "nowrap" }}>{formatDateTime(event.at)}</td>
                  <td className="small">
                    {event.kind === "transition"
                      ? event.fromState ? `${stateLabel(event.fromState)} to ${stateLabel(event.toState!)}` : `Created as ${stateLabel(event.toState!)}`
                      : event.kind.replaceAll("_", " ")}
                  </td>
                  <td>{event.activationId ? <Link href={`/admin/review/${event.activationId}`} className="mono small">{refs.get(event.activationId) ?? "unknown"}</Link> : <span className="muted small">None</span>}</td>
                  <td className="small">{event.actorId ? names.get(event.actorId) ?? "Unknown user" : <span className="muted">System</span>}</td>
                  <td className="small" style={{ maxWidth: 520 }}>{event.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
