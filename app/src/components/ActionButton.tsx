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
  describe?: (data: unknown) => string;
};

/** A button that POSTs to an API route, shows the outcome, and refreshes the page. */
export function ActionButton({ url, label, busyLabel, body = {}, className = "btn small", confirm, describe }: Props) {
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
    if (describe) setMessage({ ok: true, text: describe(result.data) });
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
