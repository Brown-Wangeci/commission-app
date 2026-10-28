"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { postJson } from "@/lib/client-api";

type Action = "approve" | "refuse";

/** Approve or reject straight from the queue. A reason is still required. */
export function QueueRowActions({ activationId, reference }: { activationId: string; reference: string }) {
  const router = useRouter();
  const [open, setOpen] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!open) return;
    setBusy(true);
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "");
    const result = await postJson(`/api/admin/review/${activationId}/${open}`, { reason });
    setBusy(false);
    if (!result.ok) {
      setError(result.fieldErrors.reason ?? result.message);
      return;
    }
    setOpen(null);
    router.refresh();
  }

  if (!open) {
    return (
      <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
        <button type="button" className="btn small" onClick={() => setOpen("approve")}>Approve</button>
        <button type="button" className="btn small danger" onClick={() => setOpen("refuse")}>Reject</button>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="stack-sm" style={{ minWidth: 240 }}>
      <label className="tiny strong" htmlFor={`reason-${activationId}`}>
        {open === "approve" ? `Why approve ${reference}?` : `Why reject ${reference}?`}
      </label>
      <textarea id={`reason-${activationId}`} name="reason" className="textarea" style={{ minHeight: 60 }} required minLength={5} autoFocus />
      {error && <span className="field-error">{error}</span>}
      <div className="row" style={{ gap: 6 }}>
        <button type="submit" className={`btn small ${open === "approve" ? "primary" : "danger"}`} disabled={busy}>
          {open === "approve" ? "Approve and pay" : "Reject"}
        </button>
        <button type="button" className="btn small" onClick={() => setOpen(null)} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}
