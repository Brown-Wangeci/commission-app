import Link from "next/link";
import { requirePageRole } from "@/lib/auth/session";
import { PostJobForm } from "@/components/client/PostJobForm";

export default async function NewJobPage() {
  await requirePageRole("client");
  return (
    <main className="page page-narrow">
      <div className="breadcrumb"><Link href="/client">&larr; Jobs</Link></div>
      <div className="page-header">
        <div>
          <h1>Post a job</h1>
          <p className="muted small">Agents are assigned to your job by the platform. Each assignment locks one payout in escrow until the activation is decided.</p>
        </div>
      </div>
      <div className="card card-pad"><PostJobForm /></div>
    </main>
  );
}
