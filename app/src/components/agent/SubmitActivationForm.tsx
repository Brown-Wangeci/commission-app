"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { postForm, type FieldErrors } from "@/lib/client-api";
import { nairobiDate, validateEvidence, type FieldDefinition } from "@/lib/evidence/fields";
import { EvidenceFieldInputs } from "./EvidenceFieldInputs";

type Region = { code: string; name: string };
type JobArea = { title: string; areaName: string; areaLat: number; areaLon: number; areaRadiusM: number };
type Fix = { lat: number; lon: number; accuracy: number | null };
type Photo = { file: File; capturedAt: string; fix: Fix | null };

type Props = {
  assignmentId: string;
  job: JobArea;
  regions: Region[];
  /** The platform's own fields (src/lib/evidence/platform.ts). */
  platformFields: FieldDefinition[];
  /** The job's configured fields, from the configuration version below. */
  jobFields: FieldDefinition[];
  evidenceConfigId: string;
  configVersion: number;
};

const APP_VERSION = "web-0.1.0";

function deviceId(): string {
  const key = "ledgerfield-device-id";
  try {
    const existing = window.localStorage.getItem(key);
    if (existing) return existing;
    const created = `web-${crypto.randomUUID().slice(0, 12)}`;
    window.localStorage.setItem(key, created);
    return created;
  } catch {
    return `web-${crypto.randomUUID().slice(0, 12)}`;
  }
}

function deviceOs(): string {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("android")) return "android";
  if (/iphone|ipad|ipod/.test(ua)) return "ios";
  if (ua.includes("kaios")) return "kaios";
  if (ua.includes("windows")) return "windows";
  if (ua.includes("mac os")) return "macos";
  return "other";
}

function FieldError({ errors, name }: { errors: FieldErrors; name: string }) {
  return errors[name] ? <span className="field-error">{errors[name]}</span> : null;
}

function locate(onFix: (fix: Fix) => void, onFail: () => void): void {
  if (!navigator.geolocation) return onFail();
  navigator.geolocation.getCurrentPosition(
    (p) => onFix({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
    onFail,
    { enableHighAccuracy: true, timeout: 10000 },
  );
}

/** Each photo travels with its own capture time and place, per field. */
function buildForm(form: HTMLFormElement, photos: Record<string, Photo[]>, device: { id: string; os: string }): FormData {
  const data = new FormData(form);
  for (const [key, list] of Object.entries(photos)) {
    for (const photo of list) data.append(`photos:${key}`, photo.file);
    data.set(`photoMeta:${key}`, JSON.stringify(list.map((photo) => ({
      capturedAt: photo.capturedAt,
      gpsLat: photo.fix?.lat ?? null,
      gpsLon: photo.fix?.lon ?? null,
      gpsAccuracyM: photo.fix?.accuracy ?? null,
      locationSource: photo.fix ? "device" : "none",
    }))));
  }
  data.set("deviceId", device.id);
  data.set("deviceOs", device.os);
  data.set("appVersion", APP_VERSION);
  return data;
}

/** Server errors arrive as fields.<key>; the inputs are keyed by field key. */
function byFieldKey(errors: FieldErrors): Record<string, string> {
  return Object.fromEntries(Object.entries(errors).map(([path, message]) => [path.replace(/^fields\./, ""), message]));
}

/**
 * The activation submission form (multipart to /api/agent/activations),
 * rendered from the platform's fields and the job's configuration (FR-09).
 * It checks the evidence in the browser with the same rules the server uses,
 * to show problems before uploading; the server checks again regardless.
 */
export function SubmitActivationForm({ assignmentId, job, regions, platformFields, jobFields, evidenceConfigId, configVersion }: Props) {
  const router = useRouter();
  const [device, setDevice] = useState({ id: "", os: "" });
  const [fix, setFix] = useState<Fix | null>(null);
  const [coords, setCoords] = useState({ lat: "", lon: "", accuracy: "" });
  const [photos, setPhotos] = useState<Record<string, Photo[]>>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const today = nairobiDate(new Date());
  const allFields = [...platformFields, ...jobFields];

  const applyFix = (next: Fix) => {
    setFix(next);
    setCoords({ lat: next.lat.toFixed(6), lon: next.lon.toFixed(6), accuracy: next.accuracy === null ? "" : String(Math.round(next.accuracy)) });
  };

  useEffect(() => {
    setDevice({ id: deviceId(), os: deviceOs() });
    locate(applyFix, () => setMessage("Your location is not available. Enter it by hand below."));
  }, []);

  /** A photo is stamped with its own file time and the device's location at the moment it is added. */
  function addPhotos(key: string, files: File[]) {
    const field = allFields.find((f) => f.key === key);
    const max = field?.type === "photo" ? field.format.maxCount : 0;
    const added = files.map((file) => ({ file, capturedAt: new Date(file.lastModified).toISOString(), fix }));
    setPhotos((current) => ({ ...current, [key]: [...(current[key] ?? []), ...added].slice(0, max) }));
  }

  function removePhoto(key: string, index: number) {
    setPhotos((current) => ({ ...current, [key]: (current[key] ?? []).filter((_, i) => i !== index) }));
  }

  /** The same rules the server applies, run first in the browser. */
  function checkHere(form: HTMLFormElement): FieldErrors | null {
    const data = new FormData(form);
    const values = Object.fromEntries(allFields.map((f) => [f.key, String(data.get(`field:${f.key}`) ?? "")]));
    const photoCounts = Object.fromEntries(Object.entries(photos).map(([key, list]) => [key, list.length]));
    const result = validateEvidence(allFields, { values, photoCounts }, { today });
    if (result.ok) return null;
    setMessage(result.missing.length > 0 ? `Missing mandatory field${result.missing.length === 1 ? "" : "s"}: ${result.missing.join(", ")}.` : "Some fields are not in the expected format.");
    return Object.fromEntries(result.issues.map((issue) => [issue.key, issue.message]));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    const local = checkHere(event.currentTarget);
    setErrors(local ?? {});
    if (local) return;
    setBusy(true);
    const result = await postForm<{ activationId: string }>("/api/agent/activations", buildForm(event.currentTarget, photos, device));
    setBusy(false);
    if (!result.ok) {
      setErrors(byFieldKey(result.fieldErrors));
      setMessage(result.message);
      return;
    }
    router.push(`/agent/activations/${result.data.activationId}`);
    router.refresh();
  }

  const fieldErrors = byFieldKey(errors);
  const attached = Object.fromEntries(Object.entries(photos).map(([key, list]) => [key, list.map((p) => ({ name: p.file.name, located: p.fix !== null }))]));

  return (
    <form className="stack-lg" onSubmit={submit} noValidate>
      <input type="hidden" name="assignmentId" value={assignmentId} />
      <input type="hidden" name="evidenceConfigId" value={evidenceConfigId} />
      {message && <div className="alert error" role="alert">{message}</div>}

      <fieldset className="stack">
        <legend>Every activation</legend>
        <EvidenceFieldInputs fields={platformFields} errors={fieldErrors} photos={attached} onAddPhotos={addPhotos} onRemovePhoto={removePhoto} locationKnown={fix !== null} today={today} />
      </fieldset>

      <fieldset className="stack">
        <legend>Evidence for this job</legend>
        <p className="hint">Set by the client for this job (version {configVersion} of its evidence fields).</p>
        {jobFields.length === 0
          ? <p className="small muted">This job asks for nothing beyond the fields above.</p>
          : <EvidenceFieldInputs fields={jobFields} errors={fieldErrors} photos={attached} onAddPhotos={addPhotos} onRemovePhoto={removePhoto} locationKnown={fix !== null} today={today} />}
      </fieldset>

      <fieldset className="stack">
        <legend>Captured by your device</legend>
        <div className="grid-3">
          <div className="field"><label htmlFor="gpsLat">Latitude</label><input id="gpsLat" name="gpsLat" className="input" value={coords.lat} onChange={(e) => setCoords({ ...coords, lat: e.target.value })} /><FieldError errors={errors} name="gpsLat" /></div>
          <div className="field"><label htmlFor="gpsLon">Longitude</label><input id="gpsLon" name="gpsLon" className="input" value={coords.lon} onChange={(e) => setCoords({ ...coords, lon: e.target.value })} /><FieldError errors={errors} name="gpsLon" /></div>
          <div className="field"><label htmlFor="gpsAccuracyM">Accuracy (m)</label><input id="gpsAccuracyM" name="gpsAccuracyM" className="input" value={coords.accuracy} onChange={(e) => setCoords({ ...coords, accuracy: e.target.value })} /></div>
        </div>
        <div className="row wrap">
          <button type="button" className="btn small" onClick={() => locate(applyFix, () => setMessage("Location is not available in this browser."))}>Use my current location</button>
        </div>
        <p className="hint">Job area: {job.areaName}, within {job.areaRadiusM} m of {job.areaLat.toFixed(4)}, {job.areaLon.toFixed(4)}.</p>
      </fieldset>

      <details>
        <summary className="small">Simulated device details (demonstration only)</summary>
        <div className="stack" style={{ marginTop: 12 }}>
          <p className="hint">
            A field app would report these from the phone and the network. In this web version they are filled in by the browser and can be changed to demonstrate how the model reacts.
          </p>
          <div className="grid-2">
            <div className="field"><span className="label">Device</span><span className="mono small">{device.id || "..."} &middot; {device.os} &middot; {APP_VERSION}</span></div>
            <div className="field">
              <label htmlFor="networkType">Network</label>
              <select id="networkType" name="networkType" className="select" defaultValue="cellular"><option value="cellular">Mobile data</option><option value="wifi">Wifi</option></select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="ipRegion">Region reported by the network</label>
            <select id="ipRegion" name="ipRegion" className="select" defaultValue="">
              <option value="">Same region as the GPS fix (no geo-IP lookup in this build)</option>
              {regions.map((region) => <option key={region.code} value={region.code}>{region.name} ({region.code})</option>)}
            </select>
          </div>
          <button type="button" className="btn small" onClick={() => applyFix({ lat: job.areaLat, lon: job.areaLon, accuracy: 10 })}>
            Use the job area centre as my location (demo)
          </button>
        </div>
      </details>

      <button type="submit" className="btn primary" disabled={busy}>{busy ? "Submitting and checking" : "Submit activation"}</button>
    </form>
  );
}
