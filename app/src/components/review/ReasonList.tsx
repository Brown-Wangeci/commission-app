import type { ReasonView } from "@/lib/review/reasons";
import { capitalise } from "@/lib/review/copy";
import { formatContribution } from "@/lib/format";

/**
 * "What moved the score": each factor in plain English with its signed
 * contribution, largest first. Factors about the agent's history are marked
 * and tinted so a reviewer can see when they are being told about the person
 * rather than this job. With `top`, only that many show at first and the
 * rest open on click, so the reasons that matter most are what is read first.
 */
function Factor({ reason }: { reason: ReasonView }) {
  return (
    <li className={`factor${reason.isAgentLevel ? " agent-level" : ""}`}>
      <span className="level">
        <span className={`tag ${reason.isAgentLevel ? "agent" : "submission"}`}>
          {reason.isAgentLevel ? "About the agent" : "About this submission"}
        </span>
      </span>
      <span className="text">{capitalise(reason.description)}</span>
      <span className={`value ${reason.raisesRisk ? "up" : "down"}`} title={reason.raisesRisk ? "Raises risk" : "Lowers risk"}>
        {formatContribution(reason.contribution)}
      </span>
    </li>
  );
}

export function ReasonList({ reasons, top }: { reasons: ReasonView[]; top?: number }) {
  if (reasons.length === 0) return <p className="small muted">The model reported no factors for this score.</p>;
  const shown = top === undefined ? reasons : reasons.slice(0, top);
  const rest = top === undefined ? [] : reasons.slice(top);
  const agentCount = reasons.filter((reason) => reason.isAgentLevel).length;
  const legend =
    agentCount === 0
      ? "None of these factors is about the agent's history; all are about this submission."
      : `${agentCount} of ${reasons.length} factors describe the agent's past activity, not this submission.`;
  return (
    <>
      <ul className="factors">
        {shown.map((reason) => <Factor key={reason.rank} reason={reason} />)}
      </ul>
      {rest.length > 0 && (
        <details className="more-factors">
          <summary className="small">{rest.length} more factor{rest.length === 1 ? "" : "s"}</summary>
          <ul className="factors">
            {rest.map((reason) => <Factor key={reason.rank} reason={reason} />)}
          </ul>
        </details>
      )}
      <p className="legend">
        <span>
          {legend} Positive values raise the risk; negative values lower it.
        </span>
      </p>
    </>
  );
}
