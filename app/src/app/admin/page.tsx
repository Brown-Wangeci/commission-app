import Link from "next/link";
import type { ActivationState } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePageRole } from "@/lib/auth/session";
import { ALL_STATES, stateLabel } from "@/lib/activations/states";
import { formatDateTime, formatProbability } from "@/lib/format";
import { modelName } from "@/lib/review/copy";
import { HoldWindowPanel } from "@/components/HoldWindowPanel";
import { NotificationsPanel } from "@/components/NotificationsPanel";
import { StateChip } from "@/components/review/StateChip";

async function counts(): Promise<Map<ActivationState, number>> {
  const groups = await prisma.activation.groupBy({ by: ["state"], _count: { _all: true } });
  return new Map(groups.map((g) => [g.state, g._count._all]));
}

/** Counts by state, recent decisions, and the hold-window controls. */
export default async function AdminDashboardPage() {
  const user = await requirePageRole("admin");
  const [byState, scores, reviews, unscored] = await Promise.all([
    counts(),
    prisma.scoringDecision.findMany({ orderBy: { recordedAt: "desc" }, take: 8, include: { activation: true } }),
    prisma.reviewItem.findMany({
      where: { closedAt: { not: null }, action: { in: ["approved", "refused", "evidence_requested"] } },
      orderBy: { closedAt: "desc" }, take: 8, include: { activation: true, reviewer: true },
    }),
    prisma.activation.count({ where: { unscoredStage: { not: null } } }),
  ]);
  return (
    <main className="page">
      <div className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p className="muted small">Activations by state. Scored-at-submission and scored-at-hold-close are passed through within one step, so they are normally zero.</p>
        </div>
        <Link href="/admin/review" className="btn primary">Open the review queue</Link>
      </div>
      <NotificationsPanel userId={user.id} linkBase="/admin/review" />
      {unscored > 0 && <div className="alert error" style={{ marginBottom: 16 }}>{unscored} activation{unscored === 1 ? "" : "s"} could not be scored and {unscored === 1 ? "is" : "are"} waiting for a person. <Link href="/admin/review">Open the queue</Link>.</div>}
      <div className="grid-4" style={{ marginBottom: 20 }}>
        {ALL_STATES.map((state) => (
          <div key={state} className="card stat">
            <div className="stat-label">{stateLabel(state)}</div>
            <div className="stat-value">{byState.get(state) ?? 0}</div>
          </div>
        ))}
      </div>
      <div className="grid-2" style={{ marginBottom: 20 }}>
        <section className="card">
          <div className="card-pad"><h2>Recent model scores</h2></div>
          {scores.length === 0 ? <div className="empty">No scores yet.</div> : (
            <ul className="timeline" style={{ padding: "0 20px 8px" }}>
              {scores.map((d) => (
                <li key={d.id} className="row-between">
                  <span><Link href={`/admin/review/${d.activationId}`} className="mono small">{d.activation.reference}</Link> <span className="small">{modelName(d.mode)}: {formatProbability(d.probability)}, {d.band.replace("_", " ")}</span></span>
                  <span className="tiny muted">{formatDateTime(d.recordedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card">
          <div className="card-pad"><h2>Recent reviewer decisions</h2></div>
          {reviews.length === 0 ? <div className="empty">No reviewer decisions yet.</div> : (
            <ul className="timeline" style={{ padding: "0 20px 8px" }}>
              {reviews.map((item) => (
                <li key={item.id}>
                  <div className="row-between">
                    <span><Link href={`/admin/review/${item.activationId}`} className="mono small">{item.activation.reference}</Link> <span className="small">{item.action?.replace("_", " ")} by {item.reviewer?.name ?? "unknown"}</span></span>
                    <StateChip state={item.activation.state} />
                  </div>
                  <div className="tiny muted">{item.closedAt ? formatDateTime(item.closedAt) : ""} &middot; {item.reason}</div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <HoldWindowPanel />
    </main>
  );
}
