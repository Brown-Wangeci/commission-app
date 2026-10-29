import Link from "next/link";
import { prisma } from "@/lib/db";
import { clientFor } from "@/lib/auth/actors";
import { requirePageRole } from "@/lib/auth/session";
import { clientEscrow } from "@/lib/escrow/client";
import { PostJobForm } from "@/components/client/PostJobForm";

export default async function NewJobPage() {
  const client = await clientFor(await requirePageRole("client"));
  const escrow = await clientEscrow(prisma, client.id);
  return (
    <main className="page page-narrow">
      <div className="breadcrumb"><Link href="/client">&larr; Jobs</Link></div>
      <div className="page-header">
        <div>
          <h1>Post a job</h1>
          <p className="muted small">
            Publishing locks the job&rsquo;s maximum liability (every activation paid in full) from your escrow, and is refused if your
            available balance does not cover it. Agents are assigned by the platform.
          </p>
        </div>
      </div>
      <div className="card card-pad"><PostJobForm availableCents={escrow.availableCents} /></div>
    </main>
  );
}
