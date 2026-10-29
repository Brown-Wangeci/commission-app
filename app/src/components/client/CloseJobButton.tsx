"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/client-api";
import { formatCents } from "@/lib/money/cents";

/**
 * Closes a job after the client confirms. The confirmation states what
 * returns to the balance now, and what stays committed until decided.
 */
export function CloseJobButton({ jobId, unspentCents, inProgressCents }: { jobId: string; unspentCents: number; inProgressCents: number }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function close() {
    setBusy(true);
    setError(null);
    const result = await postJson<{ returnedCents: number }>(`/api/client/jobs/${jobId}/close`, {});
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setConfirming(false);
    router.refresh();
  }

  if (!confirming) {
    return <button type="button" className="btn" onClick={() => setConfirming(true)}>Close this job</button>;
  }
  return (
    <div className="stack-sm">
      <p className="small">
        Closing returns <strong className="num">{formatCents(unspentCents)}</strong> to your available balance now. No new agents can be
        assigned.{inProgressCents > 0 ? ` ${formatCents(inProgressCents)} stays committed until those activations are decided.` : ""}
      </p>
      <div className="row">
        <button type="button" className="btn danger" onClick={close} disabled={busy}>{busy ? "Closing" : "Close the job"}</button>
        <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
      </div>
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}
