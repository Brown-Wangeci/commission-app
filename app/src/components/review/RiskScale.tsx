import { formatProbability } from "@/lib/format";

type Props = { probability: number; releaseThreshold: number; rejectThreshold: number };

const pct = (value: number) => `${(value * 100).toFixed(2)}%`;

function edgeClass(position: number): string {
  if (position < 0.12) return " left";
  if (position > 0.88) return " right";
  return "";
}

/**
 * Lowers risk on the left, raises risk on the right, with the auto-approve
 * cut-off, this submission's score and the auto-reject cut-off marked. The
 * cut-offs are the ones stored with this decision, exactly as the scoring
 * service returned them for the model that produced the score.
 */
export function RiskScale({ probability, releaseThreshold, rejectThreshold }: Props) {
  const label =
    `Score ${formatProbability(probability)}; auto-approve at or below ${formatProbability(releaseThreshold)}; ` +
    `auto-reject above ${formatProbability(rejectThreshold)}`;
  return (
    <div className="scale" role="img" aria-label={label}>
      <div className="scale-ends">
        <span>Lowers risk</span>
        <span>Raises risk</span>
      </div>
      <div style={{ position: "relative", height: 20, marginTop: 6 }}>
        <span
          className={`scale-mark${edgeClass(probability)}`}
          style={{ left: pct(probability), fontWeight: 700, color: "var(--ink)", fontSize: 12 }}
        >
          This submission {formatProbability(probability)}
        </span>
      </div>
      <div className="scale-track" aria-hidden="true" style={{ position: "relative" }}>
        <div className="zone release" style={{ width: pct(releaseThreshold) }} />
        <div className="zone review" style={{ width: pct(rejectThreshold - releaseThreshold) }} />
        <div className="zone reject" style={{ flex: 1 }} />
      </div>
      <div style={{ position: "relative", height: 0 }}>
        <span
          style={{ position: "absolute", left: pct(probability), top: -14, width: 4, height: 16, marginLeft: -2, background: "var(--ink)", borderRadius: 2 }}
        />
      </div>
      <div className="scale-marks">
        <div className={`scale-mark${edgeClass(releaseThreshold)}`} style={{ left: pct(releaseThreshold) }}>
          <span className="tick" />
          <span>Auto-approve cut-off</span>
          <span className="num">{formatProbability(releaseThreshold)}</span>
        </div>
        <div className={`scale-mark${edgeClass(rejectThreshold)}`} style={{ left: pct(rejectThreshold) }}>
          <span className="tick" />
          <span>Auto-reject cut-off</span>
          <span className="num">{formatProbability(rejectThreshold)}</span>
        </div>
      </div>
    </div>
  );
}
