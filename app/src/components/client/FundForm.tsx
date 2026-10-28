"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { postJson } from "@/lib/client-api";

/** Deposit money into a job's escrow. */
export function FundForm({ jobId, suggestedKsh }: { jobId: string; suggestedKsh: number }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amountKsh = new FormData(event.currentTarget).get("amountKsh");
    setBusy(true);
    setError(null);
    setDone(null);
    const result = await postJson<{ amountKsh: number }>(`/api/client/jobs/${jobId}/fund`, { amountKsh });
    setBusy(false);
    if (!result.ok) {
      setError(result.fieldErrors.amountKsh ?? result.message);
      return;
    }
    setDone(`KSh ${new Intl.NumberFormat("en-KE").format(result.data.amountKsh)} deposited.`);
    router.refresh();
  }

  return (
    <form className="stack-sm" onSubmit={submit}>
      <label htmlFor="amountKsh" className="label">Deposit into escrow (KSh)</label>
      <div className="row">
        <input id="amountKsh" name="amountKsh" className="input" inputMode="numeric" defaultValue={String(suggestedKsh)} style={{ maxWidth: 180 }} />
        <button type="submit" className="btn primary" disabled={busy}>{busy ? "Depositing" : "Fund escrow"}</button>
      </div>
      {error && <span className="field-error">{error}</span>}
      {done && <span className="tiny" style={{ color: "var(--accent)" }}>{done}</span>}
    </form>
  );
}
