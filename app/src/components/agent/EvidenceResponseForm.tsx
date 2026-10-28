"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { postForm } from "@/lib/client-api";

type Fix = { lat: number; lon: number; accuracy: number };

/** The agent answers a reviewer's evidence request with a note and/or photos. */
export function EvidenceResponseForm({ activationId }: { activationId: string }) {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      </div>
      <div className="field">
        <label htmlFor="responsePhotos">Photos ({files.length})</label>
        <input id="responsePhotos" type="file" multiple accept="image/jpeg,image/png,image/webp,image/heic,image/heif" onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
        <span className="hint">Add a note, photos, or both. Your submission goes back to the reviewer when you send this.</span>
      </div>
      {error && <div className="alert error" role="alert">{error}</div>}
      <button type="submit" className="btn primary" disabled={busy}>{busy ? "Sending" : "Send to the reviewer"}</button>
    </form>
  );
}
