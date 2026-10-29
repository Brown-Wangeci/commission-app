"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson, type FieldErrors } from "@/lib/client-api";
import type { FieldDefinition } from "@/lib/evidence/fields";
import { EvidenceFieldsEditor, rowsFromDefinitions, toFieldInput, type EditorRow } from "./EvidenceFieldsEditor";

/** Edits a published job's evidence fields; saving adds the next configuration version. */
export function EditEvidenceFields({ jobId, fields, version }: { jobId: string; fields: FieldDefinition[]; version: number }) {
  const router = useRouter();
  const [rows, setRows] = useState<EditorRow[]>(() => rowsFromDefinitions(fields));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setMessage(null);
    const result = await postJson<{ version: number }>(`/api/client/jobs/${jobId}/evidence-config`, { fields: rows.map(toFieldInput) });
    setBusy(false);
    if (!result.ok) {
      setErrors(Object.fromEntries(Object.entries(result.fieldErrors).map(([path, text]) => [path.replace(/^fields\./, "evidenceFields."), text])));
      setMessage(result.message);
      return;
    }
    router.push(`/client/jobs/${jobId}`);
    router.refresh();
  }

  return (
    <div className="stack-lg">
      {message && <div className="alert error" role="alert">{message}</div>}
      <EvidenceFieldsEditor rows={rows} onChange={setRows} errors={errors} />
      <div className="row">
        <button type="button" className="btn primary" onClick={save} disabled={busy}>{busy ? "Saving" : `Save as version ${version + 1}`}</button>
      </div>
    </div>
  );
}
