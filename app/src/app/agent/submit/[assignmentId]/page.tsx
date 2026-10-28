import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { agentFor } from "@/lib/auth/actors";
import { requirePageRole } from "@/lib/auth/session";
import { assignmentForSubmission } from "@/lib/agents/views";
import { MAX_PHOTOS } from "@/lib/activations/submit";
import { ApiError } from "@/lib/http/errors";
import { REGIONS } from "@/lib/geo";
import { formatKsh } from "@/lib/format";
import { SubmitActivationForm } from "@/components/agent/SubmitActivationForm";

export default async function SubmitPage({ params }: { params: Promise<{ assignmentId: string }> }) {
  const agent = await agentFor(await requirePageRole("agent"));
  const assignment = await assignmentForSubmission(agent.id, (await params).assignmentId).catch((error) => {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  });
  if (assignment.activation) redirect(`/agent/activations/${assignment.activation.id}`);
  if (!assignment.acceptedAt) redirect("/agent");
  return (
    <main className="page page-narrow">
      <div className="breadcrumb"><Link href="/agent">&larr; My jobs</Link></div>
      <div className="page-header">
        <div>
          <h1>Submit an activation</h1>
          <p className="muted small">
            {assignment.job.title} for {assignment.job.client.name} &middot; pays {assignment.hold ? formatKsh(assignment.hold.amountKsh) : "amount unavailable"} once approved
          </p>
        </div>
      </div>
      <div className="card card-pad">
        <SubmitActivationForm
          assignmentId={assignment.id}
          job={{ title: assignment.job.title, areaName: assignment.job.areaName, areaLat: assignment.job.areaLat, areaLon: assignment.job.areaLon, areaRadiusM: assignment.job.areaRadiusM }}
          regions={REGIONS.map((region) => ({ code: region.code, name: region.name }))}
          maxPhotos={MAX_PHOTOS}
        />
      </div>
    </main>
  );
}
