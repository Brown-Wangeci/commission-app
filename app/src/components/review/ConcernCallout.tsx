import Link from "next/link";
import type { ReviewDetail } from "@/lib/review/detail";
import { explainConcern, type ConcernAction } from "@/lib/review/concern";
import { describeFailureKind } from "@/lib/scoring/status";
import { formatContribution, formatDateTime } from "@/lib/format";
import { stageName } from "@/lib/review/copy";

function actionHref(action: ConcernAction, detail: ReviewDetail): string {
  switch (action.kind) {
    case "photo":
      return `/admin/review/${detail.id}/evidence#photo-${action.sequence}`;
    case "gallery":
      return `/admin/review/${detail.id}/evidence`;
    case "map":
      return "#location";
    case "previous":
      return `/admin/review/${action.activationId}`;
    case "history":
      return `/admin/agents/${action.agentId}`;
    case "ask":
      return "#decide-ask";
  }
}

function Unscored({ detail }: { detail: ReviewDetail }) {
  const { health } = detail;
  return (
    <section className="callout warn" aria-labelledby="concern-heading">
      <div className="callout-head">
        <h2 id="concern-heading">Check this first &mdash; this submission has no score</h2>
      </div>
      <p className="small">
        The model could not score it {stageName(detail.unscoredStage ?? "t0")}
        {health.lastFailure ? `: ${describeFailureKind(health.lastFailure.kind)}` : ""}. {health.failedAttempts} failed attempt
        {health.failedAttempts === 1 ? "" : "s"} recorded.{" "}
        {health.pendingRetry
          ? `The next automatic retry is due ${formatDateTime(health.pendingRetry.dueAt)}; any score it returns is advice only.`
          : health.gaveUp
            ? "Automatic retries have stopped."
            : ""}
      </p>
      <p className="small" style={{ marginTop: 6 }}>Decide on the evidence below, or ask the agent for more.</p>
      <div className="inline-actions">
        <Link className="btn small" href={`/admin/review/${detail.id}/evidence`}>View all {detail.photos.length} photos</Link>
        <Link className="btn small" href="#location">Show the location on a map</Link>
      </div>
    </section>
  );
}

function NoConcern({ detail }: { detail: ReviewDetail }) {
  return (
    <section className="callout calm" aria-labelledby="concern-heading">
      <div className="callout-head">
        <h2 id="concern-heading">Check this first &mdash; the model raised no specific concern</h2>
      </div>
      <p className="small">None of the factors the model reported raised the risk for this submission. Check the evidence before deciding.</p>
      <div className="inline-actions">
        <Link className="btn small" href={`/admin/review/${detail.id}/evidence`}>View all {detail.photos.length} photos</Link>
      </div>
    </section>
  );
}

/** "Check this first": the factor that raised the risk most, in plain words, with the checks to make. */
export function ConcernCallout({ detail }: { detail: ReviewDetail }) {
  if (!detail.latest) return <Unscored detail={detail} />;
  if (!detail.concern) return <NoConcern detail={detail} />;
  const explanation = explainConcern(detail.concern, detail);
  return (
    <section className="callout" aria-labelledby="concern-heading">
      <div className="callout-head">
        <h2 id="concern-heading">Check this first &mdash; the model&rsquo;s biggest concern</h2>
        <span className="concern-value up" title="Signed contribution to the score">{formatContribution(detail.concern.contribution)}</span>
      </div>
      <p className="concern-headline">
        {explanation.headline}
        {detail.concern.isAgentLevel && <span className="tag agent" style={{ marginLeft: 8 }}>Agent history</span>}
      </p>
      <p className="small">{explanation.sentences.join(" ")}</p>
      {explanation.actions.length > 0 && (
        <div className="inline-actions">
          {explanation.actions.map((action) => (
            <Link key={action.label} className="btn small" href={actionHref(action, detail)}>{action.label}</Link>
          ))}
        </div>
      )}
    </section>
  );
}
