import Link from "next/link";
import { notFound } from "next/navigation";
import { agentFor } from "@/lib/auth/actors";
import { requirePageRole } from "@/lib/auth/session";
import { agentActivation } from "@/lib/agents/views";
import { ApiError } from "@/lib/http/errors";
import { formatDateTime } from "@/lib/format";
import { formatCents } from "@/lib/money/cents";
import { payoutAmountView } from "@/lib/payouts/amount";
import { StateChip } from "@/components/review/StateChip";
import { EvidenceResponseForm } from "@/components/agent/EvidenceResponseForm";
import { ReasonAction } from "@/components/ReasonAction";

type Detail = Awaited<ReturnType<typeof agentActivation>>;

function Status({ detail }: { detail: Detail }) {
  const { explanation } = detail;
  return (
    <section className="card card-pad stack">
      <h2>{explanation.headline}</h2>
      {explanation.detail && !detail.openRequest && <p>{explanation.detail}</p>}
      {detail.openRequest && <p>Answer the request below. Your submission goes back to the reviewer when you send it.</p>}
      {explanation.modelReasons.length > 0 && (
        <div>
          <p className="small muted">The automatic check gave these reasons:</p>
          <ul className="small" style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {explanation.modelReasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
        </div>
      )}
    </section>
  );
}

function Actions({ detail }: { detail: Detail }) {
  const id = detail.activation.id;
  return (
    <>
      {detail.openRequest && (
        <section className="card card-pad stack">
          <h2>A reviewer asked for more evidence</h2>
          <p className="small muted">Asked {formatDateTime(detail.openRequest.requestedAt)}</p>
          <blockquote style={{ margin: 0, paddingLeft: 12, borderLeft: "3px solid var(--agent)" }}>{detail.openRequest.message}</blockquote>
          <EvidenceResponseForm activationId={id} />
        </section>
      )}
      {detail.canContest && (
        <section className="card card-pad stack">
          <h2>Contest this refusal</h2>
          <p className="small muted">You can contest a refusal once. A reviewer will look at it again with your explanation.</p>
          <ReasonAction url={`/api/agent/activations/${id}/contest`} field="note" buttonLabel="Contest the refusal" prompt="Why should the refusal be reconsidered?" submitLabel="Send my contest" />
        </section>
      )}
      {detail.canWithdraw && (
        <section className="card card-pad stack">
          <h2>Withdraw</h2>
          <p className="small muted">Withdraw this activation if it should not be paid. This cannot be undone.</p>
          <ReasonAction url={`/api/agent/activations/${id}/withdraw`} field="reason" buttonLabel="Withdraw activation" prompt="Why are you withdrawing it?" submitLabel="Withdraw" danger />
        </section>
      )}
    </>
  );
}

/** One of the agent's activations: status, the reason for it, evidence and any action needed. */
export default async function AgentActivationPage({ params }: { params: Promise<{ id: string }> }) {
  const agent = await agentFor(await requirePageRole("agent"));
  const detail = await agentActivation(agent.id, (await params).id).catch((error) => {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  });
  const { activation } = detail;
  const photos = activation.evidence;
  const amount = payoutAmountView({ job: activation.job, hold: activation.assignment.hold, commission: activation.commission });
  return (
    <main className="page page-narrow">
      <div className="breadcrumb"><Link href="/agent/activations">&larr; My activations</Link></div>
      <div className="review-head">
        <div className="row wrap"><span className="ref">{activation.reference}</span><StateChip state={activation.state} /></div>
        <h1>{activation.job.title}</h1>
        <p className="claim">
          Submitted {formatDateTime(activation.submittedAt)} &middot; customer <span className="mono">{activation.customerMsisdnMasked}</span> &middot; pays{" "}
          {amount ? formatCents(amount.amountCents) : "amount unavailable"}
        </p>
        {amount && <span className="derivation">{amount.commission.derivation}{amount.basis === "recorded" ? " (commission recorded at approval)" : ""}</span>}
      </div>
      <div className="stack-lg">
        <Status detail={detail} />
        <Actions detail={detail} />
        <section className="card card-pad">
          <h2 style={{ marginBottom: 12 }}>Your evidence ({photos.length})</h2>
          {photos.length === 0 ? <p className="small muted">No files.</p> : (
            <div className="thumbs">
              {photos.map((item) => (
                <a key={item.id} href={`/api/evidence/${item.id}`} target="_blank" rel="noreferrer" className="thumb">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/evidence/${item.id}`} alt={item.kind === "proof" ? "Proof of activation" : `Photo ${item.sequence}`} />
                  <span className="n">{item.kind === "proof" ? "P" : item.sequence}</span>
                </a>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
