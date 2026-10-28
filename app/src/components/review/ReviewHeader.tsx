import type { ReviewDetail } from "@/lib/review/detail";
import { formatDate, formatTime, plural } from "@/lib/format";
import { StateChip, UnscoredChip } from "./StateChip";

/**
 * Reference, status, job title and the claim line. One activation is one
 * customer sign-up (the unit the scoring model scores), so the claim is
 * always for one sign-up.
 */
const SIGNUPS_PER_ACTIVATION = 1;

export function ReviewHeader({ detail }: { detail: ReviewDetail }) {
  const captured = detail.evidenceSummary.captureStart;
  const when = captured ?? detail.submittedAt;
  return (
    <header className="review-head">
      <div className="row wrap">
        <span className="ref">{detail.reference}</span>
        <StateChip state={detail.state} />
        <UnscoredChip stage={detail.unscoredStage} />
      </div>
      <h1>{detail.job.title}</h1>
      <p className="claim">
        {detail.agent.name} claims {plural(SIGNUPS_PER_ACTIVATION, "sign-up")} &middot; {captured ? "captured" : "submitted"}{" "}
        {formatDate(when)} at {formatTime(when)}
      </p>
    </header>
  );
}
