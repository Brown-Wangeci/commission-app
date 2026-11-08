import Link from "next/link";
import { prisma } from "@/lib/db";
import { stateLabel } from "@/lib/activations/states";
import { formatDateTime } from "@/lib/format";
import { anchoringStatus, type AnchoringStatus } from "@/lib/anchoring/status";
import { AnchoringActions } from "@/components/admin/AnchoringPanel";

const PAGE_SIZE = 100;

function short(hash: string | null | undefined): string {
  return hash ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : "none";
}

/** The chain's length, how much of it is anchored, and the batch in flight (FR-21, IR-05). */
function ChainCard({ status }: { status: AnchoringStatus }) {
  const open = status.open;
  return (
    <section className="card card-pad stack" style={{ marginBottom: 16 }} aria-labelledby="chain-heading">
      <h2 id="chain-heading">Hash chain and anchoring</h2>
      <p className="small">
        {status.chainLength} events chained. Anchored through sequence {status.anchoredThrough}; {status.awaitingBatch} waiting for the next batch.
        {status.contractUrl && <> Contract: <a href={status.contractUrl} target="_blank" rel="noreferrer">on the explorer</a>.</>}
      </p>
      {!status.configured && (
        <div className="alert warn">Anchoring is waiting: {status.missing.join(", ")} not set. Events are still recorded and chained.</div>
      )}
      {open && (
        <div className={`alert ${open.escalatedAt ? "error" : "info"}`}>
          Batch {String(open.fromSequence)} to {String(open.toSequence)} ({open.leafCount} events) is {open.status}, attempt {open.attempts}.
          {open.lastError && <> Last error: {open.lastError}</>}
          {open.escalatedAt && <> It has stopped retrying and needs an administrator.</>}
        </div>
      )}
      <AnchoringActions openAnchorId={open?.id ?? null} escalated={!!open?.escalatedAt} />
      {status.recent.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Events</th><th>Root</th><th>Status</th><th>Transaction</th><th>Block</th></tr></thead>
            <tbody>
              {status.recent.map((anchor) => (
                <tr key={anchor.id}>
                  <td className="small num">{String(anchor.fromSequence)} to {String(anchor.toSequence)}</td>
                  <td className="mono tiny" title={anchor.root}>{short(anchor.root)}</td>
                  <td className="small">{anchor.status}{anchor.escalatedAt ? ", stalled" : ""}</td>
                  <td className="mono tiny">{anchor.txUrl ? <a href={anchor.txUrl} target="_blank" rel="noreferrer">{short(anchor.txHash)}</a> : short(anchor.txHash)}</td>
                  <td className="small num">{anchor.blockNumber === null ? "-" : String(anchor.blockNumber)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * Every recorded event, newest first: state transitions (written by the
 * database trigger, so none can be missed) and the other actions the app
 * records (scores, failures, assignments, deposits, evidence, disputes).
 * Each carries its place in the hash chain.
 */
export default async function AuditPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const page = Math.max(1, Number.parseInt((await searchParams).page ?? "1", 10) || 1);
  const [events, total] = await Promise.all([
    prisma.auditEvent.findMany({ orderBy: [{ at: "desc" }, { id: "desc" }], skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE, include: { chain: true } }),
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
  const status = await anchoringStatus(prisma);
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
      <ChainCard status={status} />
      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>#</th><th>When</th><th>Event</th><th>Activation</th><th>Who</th><th>Detail</th><th>Hash</th></tr></thead>
            <tbody>
              {events.map((event) => (
                <tr key={String(event.id)}>
                  <td className="mono small">{event.chain ? String(event.chain.sequence) : "-"}</td>
                  <td className="small num" style={{ whiteSpace: "nowrap" }}>{formatDateTime(event.at)}</td>
                  <td className="small">
                    {event.kind === "transition"
                      ? event.fromState ? `${stateLabel(event.fromState)} to ${stateLabel(event.toState!)}` : `Created as ${stateLabel(event.toState!)}`
                      : event.kind.replaceAll("_", " ")}
                  </td>
                  <td>{event.activationId ? <Link href={`/admin/review/${event.activationId}`} className="mono small">{refs.get(event.activationId) ?? "unknown"}</Link> : <span className="muted small">None</span>}</td>
                  <td className="small">{event.actorId ? names.get(event.actorId) ?? "Unknown user" : <span className="muted">System</span>}</td>
                  <td className="small" style={{ maxWidth: 520 }}>{event.detail}</td>
                  <td className="mono tiny" title={event.chain?.hash}>{short(event.chain?.hash)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
