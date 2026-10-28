import Link from "next/link";
import { notFound } from "next/navigation";
import { clientFor } from "@/lib/auth/actors";
import { requirePageRole } from "@/lib/auth/session";
import { clientActivationForActivity } from "@/lib/jobs/jobs";
import { ApiError } from "@/lib/http/errors";
import { formatDateTime } from "@/lib/format";
import { ActivityForm } from "@/components/client/ActivityForm";

/** The client reports the customer's first week of use for one activation. */
export default async function ActivityPage({ params }: { params: Promise<{ id: string }> }) {
  const client = await clientFor(await requirePageRole("client"));
  const activation = await clientActivationForActivity(client.id, (await params).id).catch((error) => {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  });
  const back = `/client/jobs/${activation.jobId}`;
  return (
    <main className="page">
      <div className="breadcrumb"><Link href={back}>&larr; {activation.job.title}</Link></div>
      <div className="page-header">
        <div>
          <h1>First-week activity for {activation.reference}</h1>
          <p className="muted small">
            Activated {formatDateTime(activation.submittedAt)} for customer <span className="mono">{activation.customerMsisdnMasked}</span>. Report what your systems recorded for days 0 to 7.
            The hold-close check reads these figures; without them it cannot score the activation and a person decides instead.
          </p>
        </div>
      </div>
      <div className="card card-pad">
        <ActivityForm activationId={activation.id} existing={activation.activity} backHref={back} />
      </div>
    </main>
  );
}
