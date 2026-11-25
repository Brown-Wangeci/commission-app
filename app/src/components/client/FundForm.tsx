"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { postJson } from "@/lib/client-api";
import { groupKsh } from "@/lib/ui/format";
import { PhoneInput } from "@/components/PhoneInput";
import { formatCents, parseKshToCents } from "@/lib/money/cents";

type Started = { status: string; amountCents: number; failureReason: string | null };

/**
 * Funds the escrow balance by M-Pesa (FR-06). Submitting sends a prompt to the
 * phone; nothing is added to the balance until M-Pesa confirms the payment.
 * The result appears in the funding list below this form.
 */
export function FundForm() {
  const router = useRouter();
  const [errors, setErrors] = useState<{ amount?: string; phone?: string; form?: string }>({});
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const amountCents = parseKshToCents(String(form.get("amountKsh") ?? ""));
    setErrors({});
    setDone(null);
    if (amountCents === null || amountCents === 0) {
      setErrors({ amount: "Enter an amount in shillings above zero." });
      return;
    }
    setBusy(true);
    const result = await postJson<Started>("/api/client/escrow/fund", { amountCents, payerMsisdn: String(form.get("payerMsisdn") ?? "") });
    setBusy(false);
    if (!result.ok) {
      setErrors({ amount: result.fieldErrors.amountCents, phone: result.fieldErrors.payerMsisdn, form: result.fieldErrors.amountCents || result.fieldErrors.payerMsisdn ? undefined : result.message });
      return;
    }
    setDone(result.data.status === "failed" ? null : `Check your phone and enter your M-Pesa PIN to pay ${formatCents(result.data.amountCents)}.`);
    router.refresh();
  }

  return (
    <form className="stack-sm" onSubmit={submit}>
      <div className="row" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
        <div className="stack-sm">
          <label htmlFor="amountKsh" className="label">Amount (KSh)</label>
          <div className="affix prefix" style={{ maxWidth: 180 }}>
            <span className="affix-text" aria-hidden="true">KSh</span>
            <input id="amountKsh" name="amountKsh" className="input" inputMode="decimal" placeholder="5,000" onBlur={(e) => { e.target.value = groupKsh(e.target.value); }} />
          </div>
        </div>
        <div className="stack-sm">
          <label htmlFor="payerMsisdn" className="label">M-Pesa number to pay from</label>
          <PhoneInput id="payerMsisdn" name="payerMsisdn" style={{ maxWidth: 200 }} />
        </div>
        <button type="submit" className="btn" disabled={busy}>{busy ? "Sending prompt" : "Pay with M-Pesa"}</button>
      </div>
      {errors.amount && <span className="field-error">{errors.amount}</span>}
      {errors.phone && <span className="field-error">{errors.phone}</span>}
      {errors.form && <span className="field-error">{errors.form}</span>}
      {done && <span className="tiny" style={{ color: "var(--accent)" }}>{done}</span>}
    </form>
  );
}
