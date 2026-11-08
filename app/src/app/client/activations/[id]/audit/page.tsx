import Link from "next/link";
import { notFound } from "next/navigation";
import { clientFor } from "@/lib/auth/actors";
import { requirePageRole } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { AuditTrailPanel } from "@/components/audit/AuditTrailPanel";

/** The client's view of one submission's audit record (FR-22). */
export default async function ClientAuditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = await clientFor(await requirePageRole("client"));
  const activation = await prisma.activation.findUnique({ where: { id }, select: { reference: true, state: true, jobId: true, job: { select: { clientId: true, title: true } } } });
  if (!activation || activation.job.clientId !== client.id) notFound();
  return (
    <main className="page page-narrow">
      <div className="breadcrumb"><Link href={`/client/jobs/${activation.jobId}`}>&larr; {activation.job.title}</Link></div>
      <h1 style={{ marginBottom: 16 }}>Audit record for {activation.reference}</h1>
      <AuditTrailPanel apiBase={`/api/client/activations/${id}/audit`} disputed={activation.state === "disputed"} />
    </main>
  );
}
