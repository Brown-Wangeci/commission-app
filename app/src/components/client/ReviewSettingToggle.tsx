"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/client-api";
import { REVIEW_SETTING_EFFECT } from "@/lib/review/effect";

/** The client's account setting. Ticking the box saves at once; a failure puts it back and says why. */
export function ReviewSettingToggle({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [checked, setChecked] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(next: boolean) {
    setChecked(next);
    setBusy(true);
    setError(null);
    const result = await postJson<{ changed: boolean }>("/api/client/review-setting", { reviewAllSubmissions: next });
    setBusy(false);
    if (!result.ok) {
      setChecked(!next);
      setError(result.message);
      return;
    }
    router.refresh();
  }

  return (
    <div className="stack-sm">
      <label className="row" htmlFor="reviewAllSubmissions">
        <input id="reviewAllSubmissions" type="checkbox" checked={checked} disabled={busy} onChange={(e) => save(e.target.checked)} />
        <span className="strong">Require a reviewer before any payment</span>
      </label>
      <p className="small muted">{REVIEW_SETTING_EFFECT}</p>
      <p className="tiny muted" role="status">{busy ? "Saving" : `Currently ${checked ? "on" : "off"} for your account.`}</p>
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}
