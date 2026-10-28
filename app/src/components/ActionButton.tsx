"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/client-api";

type Props = {
  url: string;
  label: string;
  busyLabel?: string;
  body?: unknown;
  className?: string;
  confirm?: string;
  /** How to report a successful response; props must be serialisable, so this is a name, not a function. */
  report?: "run-summary";
};

function describeRunSummary(data: unknown): string {
  const summary = (data as { summary?: Record<string, number> }).summary ?? {};
  const ran = Object.entries(summary).filter(([, count]) => count > 0);
  return ran.length === 0 ? "Nothing was due." : ran.map(([key, count]) => `${count} ${key.replace("_", " ")}`).join(", ");
}

/** A button that POSTs to an API route, shows the outcome, and refreshes the page. */
export function ActionButton({ url, label, busyLabel, body = {}, className = "btn small", confirm, report }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function run() {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true);
    setMessage(null);
    const result = await postJson<unknown>(url, body);
    setBusy(false);
    if (!result.ok) {
      setMessage({ ok: false, text: result.message });
      return;
    }
    if (report === "run-summary") setMessage({ ok: true, text: describeRunSummary(result.data) });
    router.refresh();
  }

  return (
    <span className="stack-sm" style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start" }}>
      <button type="button" className={className} onClick={run} disabled={busy}>
        {busy ? busyLabel ?? "Working" : label}
      </button>
      {message && <span className={`tiny ${message.ok ? "muted" : "field-error"}`}>{message.text}</span>}
    </span>
  );
}
