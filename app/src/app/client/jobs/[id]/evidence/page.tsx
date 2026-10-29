import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { clientFor } from "@/lib/auth/actors";
import { requirePageRole } from "@/lib/auth/session";
import { configHistory, currentEvidenceConfig } from "@/lib/evidence/config";
import { formatDateTime, plural } from "@/lib/format";
import { EditEvidenceFields } from "@/components/client/EditEvidenceFields";

/** The client edits a job's evidence fields; every save is a new version (issue #46). */
export default async function EditEvidencePage({ params }: { params: Promise<{ id: string }> }) {
  const client = await clientFor(await requirePageRole("client"));
  const job = await prisma.job.findUnique({ where: { id: (await params).id } });
  if (!job || job.clientId !== client.id) notFound();
  const [current, history] = await Promise.all([currentEvidenceConfig(prisma, job.id), configHistory(prisma, job.id)]);
  return (
    <main className="page page-narrow">
      <div className="breadcrumb"><Link href={`/client/jobs/${job.id}`}>&larr; {job.title}</Link></div>
      <div className="page-header">
        <div>
          <h1>Evidence fields</h1>
          <p className="muted small">
            Version {current.version} is in force. Saving creates version {current.version + 1}, which every submission from then on must
            meet. Submissions already made keep the version they were checked against, so changing a field never invalidates them.
          </p>
        </div>
      </div>
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        {job.status === "open"
          ? <EditEvidenceFields jobId={job.id} fields={current.fields} version={current.version} />
          : <p className="small">This job is closed; its evidence fields can no longer change.</p>}
      </div>
      <section className="card card-pad">
        <h2 style={{ marginBottom: 8 }}>Versions</h2>
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {history.map((v) => (
            <li key={v.id}>Version {v.version}: {plural(v.fieldCount, "field")}, {plural(v.submissions, "submission")} made under it, created {formatDateTime(v.createdAt)}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
