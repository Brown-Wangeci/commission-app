import Link from "next/link";
import type { ActivationState } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePageRole } from "@/lib/auth/session";
import { stateLabel } from "@/lib/activations/states";
import { formatDateTime, formatProbability } from "@/lib/format";
import { attention, groupCounts, type Attention } from "@/lib/review/dashboard";
import { modelName } from "@/lib/review/copy";
import { EmptyState } from "@/components/EmptyState";
import { HoldWindowPanel } from "@/components/HoldWindowPanel";
import { NotificationsPanel } from "@/components/NotificationsPanel";
import { StateChip } from "@/components/review/StateChip";

type View = "scores" | "decisions" | "hold";

const VIEWS: ReadonlyArray<{ id: View; label: string }> = [
  { id: "scores", label: "Recent model scores" },
  { id: "decisions", label: "Recent reviewer decisions" },
  { id: "hold", label: "Hold window" },
];

function viewFrom(raw: string | undefined): View {
  return VIEWS.find((view) => view.id === raw)?.id ?? "scores";
}

async function counts(): Promise<Map<ActivationState, number>> {
  const groups = await prisma.activation.groupBy({ by: ["state"], _count: { _all: true } });
  return new Map(groups.map((g) => [g.state, g._count._all]));
}

/** What needs a person right now, most pressing first. When nothing does, it says so. */
function NeedsAttention({ data }: { data: Attention }) {
  if (data.total === 0) {
    return (
      <section className="callout calm" aria-labelledby="attention-heading" style={{ marginBottom: 16 }}>
        <h2 id="attention-heading">Needs your attention</h2>
        <p className="small" style={{ marginTop: 4 }}>Nothing needs you right now. New items appear here the moment they arrive.</p>
      </section>
    );
  }
  return (
    <section className="card" aria-labelledby="attention-heading" style={{ marginBottom: 16 }}>
      <div className="card-pad"><h2 id="attention-heading">Needs your attention</h2></div>
      <ul className="attention-list">
        {data.items.map((item) => (
          <li key={item.id} className={`attention-item${item.count > 0 ? " live" : ""}`}>
            <span className="attention-count">{item.count}</span>
            <div className="grow">
              <div className="strong">{item.label}</div>
              {item.count > 0 && <div className="small muted">{item.detail}</div>}
            </div>
            {item.count > 0 && <Link href={item.href} className={`btn small${item === data.items[0] ? " primary" : ""}`}>{item.action}</Link>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function StateGroups({ byState }: { byState: Map<ActivationState, number> }) {
  return (
    <div className="grid-3" style={{ marginBottom: 16 }}>
      {groupCounts(byState).map((group) => (
        <section key={group.id} className="card card-pad" aria-labelledby={`group-${group.id}`}>
          <div className="row-between">
            <h2 id={`group-${group.id}`}>{group.label}</h2>
            <span className="stat-value" style={{ fontSize: 22, lineHeight: "26px" }}>{group.total}</span>
          </div>
          <p className="tiny muted" style={{ margin: "4px 0 8px" }}>{group.note}</p>
          <ul className="state-rows">
            {group.states.map((row) => (
              <li key={row.state} className="row-between"><span className="small">{stateLabel(row.state)}</span><span className="num">{row.count}</span></li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

async function Scores() {
  const scores = await prisma.scoringDecision.findMany({ orderBy: { recordedAt: "desc" }, take: 8, include: { activation: true } });
  if (scores.length === 0) {
    return (
      <div className="card">
        <EmptyState title="No scores yet" next="Nobody needs to act. Submissions are scored automatically when an agent submits one.">
          Each model score appears here with its band, newest first.
        </EmptyState>
      </div>
    );
  }
  return (
    <section className="card">
      <ul className="timeline" style={{ padding: "0 20px 8px" }}>
        {scores.map((d) => (
          <li key={d.id} className="row-between">
            <span><Link href={`/admin/review/${d.activationId}`} className="mono small">{d.activation.reference}</Link> <span className="small">{modelName(d.mode)}: {formatProbability(d.probability)}, {d.band.replace("_", " ")}</span></span>
            <span className="tiny muted">{formatDateTime(d.recordedAt)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

async function Decisions() {
  const reviews = await prisma.reviewItem.findMany({
    where: { closedAt: { not: null }, action: { in: ["approved", "refused", "evidence_requested"] } },
    orderBy: { closedAt: "desc" }, take: 8, include: { activation: true, reviewer: true },
  });
  if (reviews.length === 0) {
    return (
      <div className="card">
        <EmptyState title="No reviewer decisions yet" next="A reviewer acts when a submission reaches the review queue." action={{ href: "/admin/review", label: "Open the review queue" }}>
          Each approval, refusal and request for evidence appears here with its reason, newest first.
        </EmptyState>
      </div>
    );
  }
  return (
    <section className="card">
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
    </section>
  );
}

/** The reviewer's dashboard: what needs a person first, then the counts by who must act, then the activity feeds. */
export default async function AdminDashboardPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const user = await requirePageRole("admin");
  const view = viewFrom((await searchParams).view);
  const [byState, needs] = await Promise.all([counts(), attention(prisma)]);
  return (
    <main className="page">
      <div className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p className="muted small">What needs a person, then where every submission stands.</p>
        </div>
        <Link href="/admin/review" className="btn">Open the review queue</Link>
      </div>
      <NeedsAttention data={needs} />
      <NotificationsPanel userId={user.id} linkBase="/admin/review" />
      <StateGroups byState={byState} />
      <nav className="tabs" aria-label="Activity">
        {VIEWS.map((tab) => (
          <Link key={tab.id} href={tab.id === "scores" ? "/admin" : `/admin?view=${tab.id}`} className={`tab${view === tab.id ? " active" : ""}`}>
            {tab.label}{tab.id === "hold" ? ` (${byState.get("held") ?? 0})` : ""}
          </Link>
        ))}
      </nav>
      {view === "scores" && <Scores />}
      {view === "decisions" && <Decisions />}
      {view === "hold" && <HoldWindowPanel />}
    </main>
  );
}
