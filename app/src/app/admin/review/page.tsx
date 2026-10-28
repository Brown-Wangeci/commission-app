import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { listQueue, type QueueRow, type QueueTab } from "@/lib/review/queue";
import { capitalise, openReasonLabel } from "@/lib/review/copy";
import { formatContribution, formatDateTime, formatKsh, formatProbability } from "@/lib/format";
import { StateChip, UnscoredChip } from "@/components/review/StateChip";
import { QueueRowActions } from "@/components/review/QueueRowActions";
import type { ReasonView } from "@/lib/review/reasons";

export const metadata: Metadata = { title: "Review queue | Ledgerfield" };

function Reasons({ title, reasons, agent }: { title: string; reasons: ReasonView[]; agent?: boolean }) {
  return (
    <div>
      <span className={`tag ${agent ? "agent" : "submission"}`}>{title}</span>
      {reasons.length === 0 ? (
        <p className="tiny muted" style={{ marginTop: 4 }}>None among the top factors</p>
      ) : (
        <ul>
          {reasons.map((reason) => (
            <li key={reason.rank}>
              <span style={{ color: reason.raisesRisk ? "var(--raise)" : "var(--lower)" }} className="mono">{formatContribution(reason.contribution)}</span>{" "}
              {capitalise(reason.description)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Score({ row }: { row: QueueRow }) {
  if (!row.latest) return <span className="muted small">No score</span>;
  return (
    <div>
      <div className="strong num">{formatProbability(row.latest.probability)}</div>
      <div className="tiny muted">{row.latest.mode.toUpperCase()} &middot; cut-offs {formatProbability(row.latest.releaseThreshold)} / {formatProbability(row.latest.rejectThreshold)}</div>
    </div>
  );
}

function Row({ row, tab }: { row: QueueRow; tab: QueueTab }) {
  return (
    <tr className="clickable">
      <td>
        <Link href={`/admin/review/${row.id}`} className="mono strong">{row.reference}</Link>
        <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
          <StateChip state={row.state} />
          <UnscoredChip stage={row.unscoredStage} />
        </div>
        {row.failedAttempts > 0 && <div className="tiny" style={{ color: "var(--danger)", marginTop: 4 }}>{row.failedAttempts} failed scoring call{row.failedAttempts === 1 ? "" : "s"}</div>}
      </td>
      <td>
        <div>{row.agentName}</div>
        <div className="tiny muted">{row.jobTitle}</div>
        <div className="tiny muted">{row.clientName}</div>
      </td>
      <td>
        <div className="small">{tab === "evidence" ? "Evidence requested" : openReasonLabel(row.openReason)}</div>
        <div className="tiny muted">since {formatDateTime(row.waitingSince)}</div>
        {row.evidenceAsked && <div className="tiny" style={{ marginTop: 4 }}>&ldquo;{row.evidenceAsked}&rdquo;</div>}
      </td>
      <td><Score row={row} /></td>
      <td>
        {row.latest ? (
          <div className="queue-reasons">
            <Reasons title="About this submission" reasons={row.submissionReasons} />
            <Reasons title="About the agent" reasons={row.agentReasons} agent />
          </div>
        ) : (
          <p className="small muted">No score yet: the model could not be reached{row.unscoredStage ? ` ${row.unscoredStage === "t0" ? "at submission" : "at hold-close"}` : ""}. Retries continue; any later score is advice only.</p>
        )}
      </td>
      <td className="num right">{row.amountKsh === null ? "Unavailable" : formatKsh(row.amountKsh)}</td>
      <td className="right">
        {tab === "waiting" ? <QueueRowActions activationId={row.id} reference={row.reference} /> : <Link className="btn small" href={`/admin/review/${row.id}`}>Open</Link>}
      </td>
    </tr>
  );
}

/** The review queue: everything waiting for a reviewer, oldest first. */
export default async function ReviewQueuePage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const tab: QueueTab = (await searchParams).tab === "evidence" ? "evidence" : "waiting";
  const [waiting, evidence] = await Promise.all([listQueue(prisma, "waiting"), listQueue(prisma, "evidence")]);
  const rows = tab === "waiting" ? waiting : evidence;
  return (
    <main className="page">
      <div className="page-header">
        <div>
          <h1>Review queue</h1>
          <p className="muted small">Oldest first. Open a submission to see its evidence, or decide here with a reason.</p>
        </div>
        {waiting.length > 0 && <Link className="btn primary" href={`/admin/review/${waiting[0].id}`}>Start reviewing</Link>}
      </div>
      <nav className="tabs" aria-label="Queue">
        <Link href="/admin/review" className={`tab${tab === "waiting" ? " active" : ""}`}>Waiting for a decision ({waiting.length})</Link>
        <Link href="/admin/review?tab=evidence" className={`tab${tab === "evidence" ? " active" : ""}`}>Awaiting evidence from the agent ({evidence.length})</Link>
      </nav>
      <div className="card">
        {rows.length === 0 ? (
          <div className="empty">{tab === "waiting" ? "Nothing is waiting for a decision." : "No evidence requests are open."}</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 150 }}>Submission</th>
                  <th style={{ minWidth: 200 }}>Agent and job</th>
                  <th style={{ minWidth: 140 }}>Why it is here</th>
                  <th style={{ minWidth: 130 }}>Score</th>
                  <th>What moved the score</th>
                  <th className="right">Payout</th>
                  <th style={{ width: 170 }}></th>
                </tr>
              </thead>
              <tbody>{rows.map((row) => <Row key={row.id} row={row} tab={tab} />)}</tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
