"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { postJson } from "@/lib/client-api";
import { formatCents, parseKshToCents } from "@/lib/money/cents";

/**
 * Deposit money into the client's escrow balance. The amount is typed in
 * shillings and sent as integer cents; a fraction of a cent is refused.
 */
export function FundForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amountCents = parseKshToCents(String(new FormData(event.currentTarget).get("amountKsh") ?? ""));
    setError(null);
    setDone(null);
    if (amountCents === null || amountCents === 0) {
      setError("Enter an amount in shillings above zero, with at most two decimal places.");
      return;
    }
    setBusy(true);
    const result = await postJson<{ amountCents: number }>("/api/client/escrow/fund", { amountCents });
    setBusy(false);
    if (!result.ok) {
      setError(result.fieldErrors.amountCents ?? result.message);
      return;
    }
    setDone(`${formatCents(result.data.amountCents)} deposited.`);
    router.refresh();
  }

  return (
    <form className="stack-sm" onSubmit={submit}>
      <label htmlFor="amountKsh" className="label">Deposit into escrow (KSh)</label>
      <div className="row">
        <input id="amountKsh" name="amountKsh" className="input" inputMode="decimal" placeholder="5,000.00" style={{ maxWidth: 180 }} />
        <button type="submit" className="btn" disabled={busy}>{busy ? "Depositing" : "Fund escrow"}</button>
      </div>
      {error && <span className="field-error">{error}</span>}
      {done && <span className="tiny" style={{ color: "var(--accent)" }}>{done}</span>}
    </form>
  );
}
