import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/http/errors";
import { reviewDetail, type ReviewDetail } from "@/lib/review/detail";
import { CLOSING_LINE } from "@/lib/review/copy";
import { stateLabel } from "@/lib/activations/states";
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
  return (
    <main className="page">
      <ReviewBreadcrumb position={detail.position} />
      <ReviewHeader detail={detail} />
      <div className="split">
        <div className="stack-lg">
          <EvidenceStrip detail={detail} />
          <ConcernCallout detail={detail} />
          <SubmittedDetails detail={detail} />
          <LocationPlot detail={detail} />
          <ReviewTimeline detail={detail} />
        </div>
        <aside className="stack-lg">
          <AgentCard agent={detail.agent} />
          <ModelAssessment detail={detail} />
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
        </aside>
      </div>
    </main>
  );
}
