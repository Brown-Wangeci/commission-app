import type { ReasonView } from "@/lib/review/reasons";
import { capitalise } from "@/lib/review/copy";
import { formatContribution } from "@/lib/format";

/**
 * "What moved the score": each factor in plain English with its signed
 * contribution, largest first. Factors about the agent's history are marked
 * and tinted so a reviewer can see when they are being told about the person
 * rather than this job.
 */
export function ReasonList({ reasons }: { reasons: ReasonView[] }) {
  if (reasons.length === 0) return <p className="small muted">The model reported no factors for this score.</p>;
  const agentCount = reasons.filter((reason) => reason.isAgentLevel).length;
  const legend =
    agentCount === 0
      ? "None of these factors is about the agent's history; all are about this submission."
      : `${agentCount} of ${reasons.length} factors describe the agent's past activity, not this submission.`;
  return (
    <>
      <ul className="factors">
        {reasons.map((reason) => (
          <li key={reason.rank} className={`factor${reason.isAgentLevel ? " agent-level" : ""}`}>
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
        ))}
      </ul>
      <p className="legend">
        <span>
          {legend} Positive values raise the risk; negative values lower it.
        </span>
      </p>
    </>
  );
}
