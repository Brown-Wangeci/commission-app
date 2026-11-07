"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { formatDateTime } from "@/lib/format";
import { formatCents } from "@/lib/money/cents";

export type FundingRow = {
  id: string;
  amountCents: number;
  status: "queued" | "sending" | "pending" | "confirmed" | "failed";
  receipt: string | null;
  failureReason: string | null;
  createdAt: Date;
};

const POLL_MS = 5000;

const DISPLAY: Record<FundingRow["status"], { label: string; chip: string; detail: string }> = {
  queued: { label: "Pending", chip: "review", detail: "Waiting to reach M-Pesa. It will be tried again automatically." },
  sending: { label: "Pending", chip: "review", detail: "Sending the prompt to your phone." },
  pending: { label: "Pending", chip: "review", detail: "Waiting for M-Pesa to confirm. Enter your PIN if your phone is prompting you." },
  confirmed: { label: "Confirmed", chip: "approved", detail: "Added to your escrow." },
  failed: { label: "Failed", chip: "failure", detail: "Nothing was added to your escrow." },
};

function isOpen(row: FundingRow): boolean {
  return row.status !== "confirmed" && row.status !== "failed";
}

/** Every funding attempt with its state (A3). Refreshes itself while one is still open. */
export function FundingList({ rows }: { rows: FundingRow[] }) {
  const router = useRouter();
  const waiting = rows.some(isOpen);

  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, router]);

  if (rows.length === 0) return <p className="small muted">No funding yet. Your escrow is credited only once M-Pesa confirms a payment.</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Requested</th><th className="right">Amount</th><th>Status</th><th>Detail</th></tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="small num">{formatDateTime(row.createdAt)}</td>
              <td className="right small num">{formatCents(row.amountCents)}</td>
              <td className="small"><span className={`chip ${DISPLAY[row.status].chip}`}>{DISPLAY[row.status].label}</span></td>
              <td className="small">
                {row.failureReason ?? DISPLAY[row.status].detail}
                {row.receipt && <div className="tiny muted mono">M-Pesa receipt {row.receipt}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
