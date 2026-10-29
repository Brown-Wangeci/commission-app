import Link from "next/link";
import { notFound } from "next/navigation";
import { clientFor } from "@/lib/auth/actors";
import { requirePageRole } from "@/lib/auth/session";
import { clientJob } from "@/lib/jobs/jobs";
import { prisma } from "@/lib/db";
import { currentEvidenceConfig } from "@/lib/evidence/config";
import { describeFormat, FIELD_TYPE_LABELS } from "@/lib/evidence/fields";
import { ApiError } from "@/lib/http/errors";
import { isFinal } from "@/lib/activations/states";
import { formatDateTime } from "@/lib/format";
import { formatCents, sumCents } from "@/lib/money/cents";
import { MoneyStat } from "@/components/Money";
import { StateChip } from "@/components/review/StateChip";
import { CloseJobButton } from "@/components/client/CloseJobButton";

/** One job: its commission, its escrow, and the outcome of every activation with its reason. */
export default async function ClientJobPage({ params }: { params: Promise<{ id: string }> }) {
  const client = await clientFor(await requirePageRole("client"));
  const detail = await clientJob(client.id, (await params).id).catch((error) => {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  });
  const { job, terms, escrow, unspentDerivation, activations } = detail;
  const evidence = await currentEvidenceConfig(prisma, job.id);
  const inProgressCents = sumCents([escrow.reservedCents, escrow.heldCents]);
  const fullyLocked = escrow.lockedCents === terms.liability.amountCents;
  return (
    <main className="page">
      <div className="breadcrumb"><Link href="/client">&larr; Jobs</Link></div>
      <div className="page-header">
        <div>
          <h1>{job.title}{job.status === "closed" && <span className="chip neutral" style={{ marginLeft: 10 }}>Closed</span>}</h1>
          <p className="muted small">
            {job.areaName}, within {job.areaRadiusM} m of {job.areaLat.toFixed(4)}, {job.areaLon.toFixed(4)} &middot; {job.slots} activations wanted
            {job.deadlineAt ? ` · deadline ${formatDateTime(job.deadlineAt)}` : ""}
            {job.closedAt ? ` · closed ${formatDateTime(job.closedAt)}` : ""}
          </p>
        </div>
      </div>
      <div className="grid-4" style={{ marginBottom: 16 }}>
        <MoneyStat label="Commission per approved submission" cents={terms.commission.amountCents} derivation={terms.commission.derivation} />
        <MoneyStat
          label="Locked at publication"
          cents={escrow.lockedCents}
          derivation={fullyLocked ? terms.liability.derivation : `converted from per-job funding; full liability ${formatCents(terms.liability.amountCents)}`}
        />
        <MoneyStat label="Released to agents" cents={escrow.releasedCents} />
        <MoneyStat
          label={job.status === "open" ? "Unspent (locked until you close the job)" : "Returned to your balance"}
          cents={escrow.unspentCents}
          derivation={unspentDerivation}
        />
      </div>
      <section className="card card-pad" style={{ marginBottom: 16 }}>
        {job.status === "open" ? (
          <div className="row-between wrap" style={{ alignItems: "flex-start", gap: 16 }}>
            <p className="small muted" style={{ maxWidth: 560 }}>
              {formatCents(inProgressCents)} is reserved or held for activations in progress. A refused or withdrawn activation&rsquo;s money
              returns to this job&rsquo;s unspent amount; closing the job returns the unspent amount to your available balance.
            </p>
            <CloseJobButton jobId={job.id} unspentCents={escrow.unspentCents} inProgressCents={inProgressCents} />
          </div>
        ) : (
          <p className="small muted">
            This job is closed. {formatCents(inProgressCents)} is still committed to activations in progress; it is released to the agent on
            approval or returned to your balance on refusal or withdrawal.
          </p>
        )}
      </section>
      <section className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="row-between wrap" style={{ marginBottom: 8 }}>
          <h2>Evidence fields <span className="muted small">(version {evidence.version})</span></h2>
          {job.status === "open" && <Link href={`/client/jobs/${job.id}/evidence`} className="btn small">Edit evidence fields</Link>}
        </div>
        {evidence.fields.length === 0 ? (
          <p className="small muted">No job-specific fields: agents submit only the platform&rsquo;s own (customer number, SIM date, capture method, optional proof).</p>
        ) : (
          <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {evidence.fields.map((field) => (
              <li key={field.key}>
                <strong>{field.label}</strong> &middot; {FIELD_TYPE_LABELS[field.type]} &middot; {field.mandatory ? "mandatory" : "optional"} &middot;{" "}
                <span className="muted">{describeFormat(field)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
      <section className="card">
        <div className="card-pad"><h2>Activations on this job ({activations.length})</h2></div>
        {activations.length === 0 ? <div className="empty">No activations yet.</div> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Reference</th><th>Agent</th><th>Submitted</th><th>Outcome</th><th>Reason</th><th>First-week activity</th></tr></thead>
              <tbody>
                {activations.map(({ activation, explanation }) => (
                  <tr key={activation.id}>
                    <td className="mono">{activation.reference}</td>
                    <td className="small">{activation.agent.user.name}</td>
                    <td className="small num">{formatDateTime(activation.submittedAt)}</td>
                    <td><StateChip state={activation.state} /></td>
                    <td className="small" style={{ maxWidth: 420 }}><strong>{explanation.headline}.</strong> {explanation.detail}</td>
                    <td className="small">
                      {activation._count.activity} of 8 days reported
                      {!isFinal(activation.state) && (
                        <div><Link href={`/client/activations/${activation.id}/activity`}>{activation._count.activity === 0 ? "Report activity" : "Update"}</Link></div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
