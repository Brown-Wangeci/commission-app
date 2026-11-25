"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { postForm } from "@/lib/client-api";
import { MAX_JOB_PHOTOS } from "@/lib/evidence/fields";
import { budgetProblem, photoShare, photoTooBigMessage } from "@/lib/evidence/photo-limits";
import { shrinkPhoto } from "@/lib/evidence/photo-resize";
import { AUDIT_TEXT_NOTICE } from "@/lib/retention/notice";

type Fix = { lat: number; lon: number; accuracy: number };

/** The agent answers a reviewer's evidence request with a note and/or photos. */
export function EvidenceResponseForm({ activationId }: { activationId: string }) {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);

  /** Shrinks each chosen photo in the browser (defect 16); the shrunk file keeps the original's modified time, which is the capture time sent below. */
  async function choose(chosen: File[]) {
    setError(null);
    setPreparing(true);
    const prepared = await Promise.all(chosen.map((file) => shrinkPhoto(file, photoShare(MAX_JOB_PHOTOS))));
    setPreparing(false);
    const refused = prepared.findIndex((p) => !p.fits);
    if (refused >= 0) setError(photoTooBigMessage(chosen[refused].name));
    setFiles(prepared.filter((p) => p.fits).map((p) => p.file));
  }

  async function currentFix(): Promise<Fix | null> {
    if (!navigator.geolocation) return null;
    return new Promise((resolve) =>
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
        () => resolve(null),
        { timeout: 8000 },
      ),
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const note = String(new FormData(event.currentTarget).get("note") ?? "");
    const tooBig = budgetProblem(files.reduce((sum, file) => sum + file.size, 0));
    if (tooBig) {
      setError(tooBig);
      return;
    }
    setBusy(true);
    setError(null);
    const fix = await currentFix();
    const data = new FormData();
    data.set("note", note);
    for (const file of files) data.append("photos", file);
    data.set("photoMeta", JSON.stringify(files.map((file) => ({
      capturedAt: new Date(file.lastModified).toISOString(),
      gpsLat: fix?.lat ?? null, gpsLon: fix?.lon ?? null, gpsAccuracyM: fix?.accuracy ?? null,
      locationSource: fix ? "device" : "none",
    }))));
    const result = await postForm(`/api/agent/activations/${activationId}/evidence`, data);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.refresh();
  }

  return (
    <form className="stack" onSubmit={submit}>
      <div className="field">
        <label htmlFor="note">Your reply</label>
        <textarea id="note" name="note" className="textarea" maxLength={2000} />
        <span className="hint">{AUDIT_TEXT_NOTICE}</span>
      </div>
      <div className="field">
        <label htmlFor="responsePhotos">Photos ({files.length})</label>
        <input id="responsePhotos" type="file" multiple accept="image/jpeg,image/png,image/webp,image/heic,image/heif" onChange={(e) => { void choose(Array.from(e.target.files ?? [])); }} />
        <span className="hint">Add a note, photos, or both. Your submission goes back to the reviewer when you send this.</span>
      </div>
      {error && <div className="alert error" role="alert">{error}</div>}
      <button type="submit" className="btn primary" disabled={busy || preparing}>{busy ? "Sending" : preparing ? "Getting photos ready" : "Send to the reviewer"}</button>
    </form>
  );
}
