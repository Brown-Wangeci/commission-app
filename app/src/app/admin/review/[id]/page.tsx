import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/http/errors";
import { reviewDetail, type ReviewDetail } from "@/lib/review/detail";
import { CLOSING_LINE } from "@/lib/review/copy";
import { stateLabel } from "@/lib/activations/states";
import { formatDateTime } from "@/lib/format";
import { ReviewBreadcrumb } from "@/components/review/ReviewBreadcrumb";
import { ReviewHeader } from "@/components/review/ReviewHeader";
import { EvidenceStrip } from "@/components/review/EvidenceStrip";
import { ConcernCallout } from "@/components/review/ConcernCallout";
import { SubmittedDetails } from "@/components/review/SubmittedDetails";
import { LocationPlot } from "@/components/review/LocationPlot";
import { ReviewTimeline } from "@/components/review/ReviewTimeline";
import { AgentCard } from "@/components/review/AgentCard";
import { ModelAssessment } from "@/components/review/ModelAssessment";
import { PayoutPanel } from "@/components/review/PayoutPanel";
import { AuditTrailPanel } from "@/components/audit/AuditTrailPanel";
import { Disclosure } from "@/components/Disclosure";

export const metadata: Metadata = { title: "Review submission | Ledgerfield" };

async function load(id: string): Promise<ReviewDetail> {
  try {
    return await reviewDetail(prisma, id);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
}

/** The admin review screen (issue #12). */
export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const detail = await load((await params).id);
  const openRequest = detail.evidenceRequests.findLast((request) => request.status === "open");
  return (
    <main className="page">
      <ReviewBreadcrumb position={detail.position} />
      <ReviewHeader detail={detail} />
      <div className="split">
        <div className="stack-lg">
          {openRequest && (
            <section className="callout calm" aria-labelledby="request-heading">
              <h2 id="request-heading">Waiting for the agent</h2>
              <p className="small">
                {openRequest.requestedByName} asked on {formatDateTime(openRequest.requestedAt)}: &ldquo;{openRequest.message}&rdquo; The submission returns to the queue when the agent responds.
              </p>
            </section>
          )}
          <ConcernCallout detail={detail} />
          <EvidenceStrip detail={detail} />
          <div>
            <Disclosure id="details" title="Submitted details" hint="Job fields, capture window, GPS, device, customer">
              <SubmittedDetails detail={detail} />
            </Disclosure>
            <Disclosure id="location" title="Where it happened" hint="Map of the job area, the GPS fix and each photo">
              <LocationPlot detail={detail} />
            </Disclosure>
            {detail.audit.length > 0 && (
              <Disclosure id="history" title="History" hint={`${detail.audit.length} event${detail.audit.length === 1 ? "" : "s"} for this submission`}>
                <ReviewTimeline detail={detail} />
              </Disclosure>
            )}
            <AuditTrailPanel collapsible apiBase={`/api/admin/activations/${detail.id}/audit`} disputed={detail.state === "disputed"} />
          </div>
        </div>
        <aside className="stack-lg">
          <PayoutPanel
            activationId={detail.id}
            stateLabel={stateLabel(detail.state)}
            amount={detail.payout.amount}
            payoutMsisdn={detail.payout.payoutMsisdn}
            canApprove={detail.actions.canApprove}
            canRefuse={detail.actions.canRefuse}
            canRequestEvidence={detail.actions.canRequestEvidence}
            nextId={detail.position?.nextId ?? null}
            closingLine={CLOSING_LINE}
          />
          <ModelAssessment detail={detail} />
          <AgentCard agent={detail.agent} />
        </aside>
      </div>
    </main>
  );
}
