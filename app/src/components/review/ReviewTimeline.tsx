import type { AuditEntry, ReviewDetail } from "@/lib/review/detail";
import { stateLabel } from "@/lib/activations/states";
import { formatDateTime } from "@/lib/format";

/**
 * Everything that happened to this submission, oldest first, read from the
 * audit log the database trigger writes. Each line names who acted (a
 * reviewer, the agent, or the system) and the recorded reason.
 */
function title(entry: AuditEntry): string {
  const who = entry.actorName ? ` by ${entry.actorName}` : "";
  switch (entry.kind) {
    case "transition":
      return entry.fromState ? `${stateLabel(entry.toState!)}${who}` : `Submitted${who}`;
    case "scoring_failed":
      return "Scoring call failed";
    case "t7_forced":
      return `Hold-close score requested${who}`;
    case "activity_reported":
      return `First-week activity reported${who}`;
    case "scoring_decision":
      return "Scored again (advice only)";
    case "dispute_opened":
      return "Refusal recorded for audit and contest";
    default:
      return entry.kind.replace("_", " ");
  }
}

function body(entry: AuditEntry): string | null {
  return entry.detail;
}

export function ReviewTimeline({ detail }: { detail: ReviewDetail }) {
  if (detail.audit.length === 0) return null;
  return (
    <section className="card card-pad" aria-labelledby="history-heading">
      <h2 id="history-heading" style={{ marginBottom: 6 }}>History</h2>
      <ul className="timeline">
        {detail.audit.map((entry, index) => (
          <li key={index}>
            <div className="when">{formatDateTime(entry.at)}</div>
            <div>{title(entry)}</div>
            {body(entry) && <div className="small muted">{body(entry)}</div>}
          </li>
        ))}
      </ul>
    </section>
  );
}
