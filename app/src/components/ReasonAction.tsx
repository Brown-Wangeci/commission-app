"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { postJson } from "@/lib/client-api";

type Props = {
  url: string;
  /** Name of the JSON field the text is sent as, e.g. "reason" or "note". */
  field: string;
  buttonLabel: string;
  prompt: string;
  submitLabel: string;
  hint?: string;
  danger?: boolean;
};

/** A button that opens a required-text form and POSTs it. */
export function ReasonAction({ url, field, buttonLabel, prompt, submitLabel, hint, danger }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const text = String(new FormData(event.currentTarget).get("text") ?? "");
    const result = await postJson(url, { [field]: text });
    setBusy(false);
    if (!result.ok) {
      setError(result.fieldErrors[field] ?? result.message);
      return;
    }
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return <button type="button" className={`btn${danger ? " danger" : ""}`} onClick={() => setOpen(true)}>{buttonLabel}</button>;
  }
  return (
    <form className="stack" onSubmit={submit}>
      <div className="field">
        <label htmlFor={`text-${field}`}>{prompt}</label>
        <textarea id={`text-${field}`} name="text" className="textarea" required minLength={5} maxLength={2000} autoFocus />
        {hint && <span className="hint">{hint}</span>}
      </div>
      {error && <div className="alert error" role="alert">{error}</div>}
      <div className="row">
        <button type="submit" className={`btn ${danger ? "danger" : "primary"}`} disabled={busy}>{busy ? "Sending" : submitLabel}</button>
        <button type="button" className="btn" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}
