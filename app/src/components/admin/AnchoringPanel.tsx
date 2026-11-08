"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ChainReport } from "@/lib/audit/chain";
import { postJson } from "@/lib/client-api";

type Props = { openAnchorId: string | null; escalated: boolean };

/** Whole-chain verification, and the retry for a stalled anchoring batch. */
export function AnchoringActions({ openAnchorId, escalated }: Props) {
  const router = useRouter();
  const [report, setReport] = useState<ChainReport | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function verifyChain() {
    setBusy(true);
    setMessage(null);
    const result = await postJson<ChainReport>("/api/admin/audit/verify-chain", {});
    setBusy(false);
    if (result.ok) setReport(result.data);
    else setMessage(result.message);
  }

  async function retry() {
    if (!openAnchorId) return;
    setBusy(true);
    const result = await postJson(`/api/admin/audit/anchors/${openAnchorId}/retry`, {});
    setBusy(false);
    setMessage(result.ok ? "Sent round again; the next scheduler run will try it." : result.message);
    router.refresh();
  }

  return (
    <div className="stack-sm">
      <div className="row wrap">
        <button type="button" className="btn" onClick={verifyChain} disabled={busy}>Verify the whole chain</button>
        {escalated && openAnchorId && <button type="button" className="btn" onClick={retry} disabled={busy}>Retry anchoring</button>}
      </div>
      {message && <span className="small">{message}</span>}
      {report && (
        <div className={`alert ${report.ok ? "ok" : "error"}`}>
          {report.ok
            ? `All ${report.checked} events recompute from their stored fields and link in order.`
            : `The chain diverges at sequence ${report.firstDivergence?.sequence} (event ${report.firstDivergence?.eventId}): ${report.firstDivergence?.detail}`}
        </div>
      )}
    </div>
  );
}
