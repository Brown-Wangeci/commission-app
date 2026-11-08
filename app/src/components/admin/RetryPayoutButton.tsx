"use client";

import { useState } from "react";
import { postJson } from "@/lib/client-api";

/** Retries a failed payout. The escrow stays held; the worker sends it on its next run. */
export function RetryPayoutButton({ disbursementId }: { disbursementId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry() {
    if (!window.confirm("Send this payout to M-Pesa again? Do this only once the cause of the failure is fixed.")) return;
    setBusy(true);
    setError(null);
    const result = await postJson(`/api/admin/payouts/${disbursementId}/retry`, {});
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    window.location.reload();
  }

  return (
    <div className="stack-sm" style={{ marginTop: 6 }}>
      <button type="button" className="btn" onClick={retry} disabled={busy}>{busy ? "Retrying" : "Retry payout"}</button>
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}
