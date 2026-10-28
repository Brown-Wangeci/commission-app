"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { postJson } from "@/lib/client-api";

export type ActivityRow = {
  day: number;
  customerActive: boolean;
  transactionCount: number;
  topupAmountKsh: number;
  usageMinutes: number;
  supportContact: boolean;
  complaintOrRefund: boolean;
  simActive: boolean;
};

const DAYS = [0, 1, 2, 3, 4, 5, 6, 7];

function rowFrom(form: FormData, day: number): ActivityRow {
  const checked = (name: string) => form.get(`${name}-${day}`) === "on";
  const number = (name: string) => Number(form.get(`${name}-${day}`) || 0);
  return {
    day,
    customerActive: checked("active"),
    transactionCount: number("tx"),
    topupAmountKsh: number("topup"),
    usageMinutes: number("minutes"),
    supportContact: checked("support"),
    complaintOrRefund: checked("complaint"),
    simActive: checked("sim"),
  };
}

/** The client reports the customer's first week (days 0 to 7), as its own systems recorded it. */
export function ActivityForm({ activationId, existing, backHref }: { activationId: string; existing: ActivityRow[]; backHref: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const byDay = new Map(existing.map((row) => [row.day, row]));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    const result = await postJson(`/api/client/activations/${activationId}/activity`, { days: DAYS.map((day) => rowFrom(form, day)) });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.push(backHref);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="stack">
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr><th>Day</th><th>Customer active</th><th>Transactions</th><th>Top-up (KSh)</th><th>Usage (min)</th><th>Contacted support</th><th>Complaint or refund</th><th>SIM active at day end</th></tr>
          </thead>
          <tbody>
            {DAYS.map((day) => {
              const row = byDay.get(day);
              return (
                <tr key={day}>
                  <td className="num">{day}</td>
                  <td><input type="checkbox" name={`active-${day}`} defaultChecked={row?.customerActive ?? false} aria-label={`Day ${day} active`} /></td>
                  <td><input className="input" name={`tx-${day}`} inputMode="numeric" defaultValue={row?.transactionCount ?? 0} style={{ width: 80 }} /></td>
                  <td><input className="input" name={`topup-${day}`} inputMode="decimal" defaultValue={row?.topupAmountKsh ?? 0} style={{ width: 90 }} /></td>
                  <td><input className="input" name={`minutes-${day}`} inputMode="decimal" defaultValue={row?.usageMinutes ?? 0} style={{ width: 80 }} /></td>
                  <td><input type="checkbox" name={`support-${day}`} defaultChecked={row?.supportContact ?? false} aria-label={`Day ${day} support`} /></td>
                  <td><input type="checkbox" name={`complaint-${day}`} defaultChecked={row?.complaintOrRefund ?? false} aria-label={`Day ${day} complaint`} /></td>
                  <td><input type="checkbox" name={`sim-${day}`} defaultChecked={row?.simActive ?? true} aria-label={`Day ${day} SIM active`} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {error && <div className="alert error" role="alert">{error}</div>}
      <button type="submit" className="btn primary" disabled={busy} style={{ alignSelf: "flex-start" }}>{busy ? "Saving" : "Save first-week activity"}</button>
    </form>
  );
}
