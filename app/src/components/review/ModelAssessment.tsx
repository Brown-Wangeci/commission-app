import { ActionButton } from "@/components/ActionButton";
import type { ReviewDetail } from "@/lib/review/detail";
import { MODEL_FRAMING, modelName, triggerLabel, whyHere } from "@/lib/review/copy";
import { formatDateTime, formatProbability } from "@/lib/format";
import { ReasonList } from "./ReasonList";
import { RiskScale } from "./RiskScale";

function currentOpenReason(detail: ReviewDetail) {
  const open = detail.reviewHistory.filter((item) => item.closedAt === null);
  return open.at(-1)?.openReason ?? null;
}

function DecisionHistory({ detail }: { detail: ReviewDetail }) {
  if (detail.decisions.length < 2) return null;
  return (
    <details style={{ marginTop: 12 }}>
      <summary className="small">All {detail.decisions.length} scores for this submission</summary>
      <ul className="timeline small" style={{ marginTop: 6 }}>
        {detail.decisions.map((decision) => (
          <li key={decision.id}>
            <strong>{modelName(decision.mode)}</strong>: {formatProbability(decision.probability)}, band {decision.band.replace("_", " ")}
            <div className="when">
              Cut-offs {formatProbability(decision.releaseThreshold)} and {formatProbability(decision.rejectThreshold)} &middot; scored{" "}
              {triggerLabel(decision.trigger)} &middot; {formatDateTime(decision.scoredAt)}
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** The model's advice for this submission, from the latest stored decision. */
export function ModelAssessment({ detail }: { detail: ReviewDetail }) {
  const latest = detail.latest;
  const reason = currentOpenReason(detail);
  return (
    <section className="card card-pad assessment" aria-labelledby="assessment-heading">
      <h2 id="assessment-heading" style={{ marginBottom: 4 }}>Model assessment</h2>
      <p className="framing">{MODEL_FRAMING}</p>
      {latest ? (
        <>
          <div className="prob-label">Fraud probability</div>
          <div className="prob">{formatProbability(latest.probability)}</div>
          <p className="tiny muted" style={{ marginTop: 4 }}>
            {modelName(latest.mode)} &middot; <span className="mono">{latest.modelVersion}</span> &middot; scored {triggerLabel(latest.trigger)}
          </p>
          <p className="why">{whyHere(reason, latest, detail.unscoredStage)}</p>
          <h3 style={{ margin: "18px 0 6px" }}>What moved the score</h3>
          <ReasonList reasons={latest.reasons} />
          <RiskScale probability={latest.probability} releaseThreshold={latest.releaseThreshold} rejectThreshold={latest.rejectThreshold} />
        </>
      ) : (
        <>
          <div className="prob-label">Fraud probability</div>
          <div className="prob muted">Unavailable</div>
          <p className="why">{whyHere(reason, null, detail.unscoredStage)}</p>
        </>
      )}
      <DecisionHistory detail={detail} />
      {detail.actions.canForceT7 && (
        <div style={{ marginTop: 14 }}>
          <ActionButton
            url={`/api/admin/activations/${detail.id}/score-t7`}
            label="Score with the hold-close model now"
            confirm="Ask the hold-close (T7) model for a score now? On a submission already with a reviewer the score is advice only."
          />
        </div>
      )}
    </section>
  );
}
