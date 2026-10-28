"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { postForm, type FieldErrors } from "@/lib/client-api";

type Region = { code: string; name: string };
type JobArea = { title: string; areaName: string; areaLat: number; areaLon: number; areaRadiusM: number };
type Fix = { lat: number; lon: number; accuracy: number | null };
type Photo = { file: File; capturedAt: string; fix: Fix | null };

type Props = { assignmentId: string; job: JobArea; regions: Region[]; maxPhotos: number };

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

function buildForm(form: HTMLFormElement, photos: Photo[], device: { id: string; os: string }): FormData {
  const data = new FormData(form);
  data.delete("photos");
  for (const photo of photos) data.append("photos", photo.file);
  data.set("photoMeta", JSON.stringify(photos.map((photo) => ({
    capturedAt: photo.capturedAt,
    gpsLat: photo.fix?.lat ?? null,
    gpsLon: photo.fix?.lon ?? null,
    gpsAccuracyM: photo.fix?.accuracy ?? null,
    locationSource: photo.fix ? "device" : "none",
  }))));
  data.set("deviceId", device.id);
  data.set("deviceOs", device.os);
  data.set("appVersion", APP_VERSION);
  return data;
}

/** The activation submission form (multipart to /api/agent/activations). */
export function SubmitActivationForm({ assignmentId, job, regions, maxPhotos }: Props) {
  const router = useRouter();
  const [device, setDevice] = useState({ id: "", os: "" });
  const [fix, setFix] = useState<Fix | null>(null);
  const [coords, setCoords] = useState({ lat: "", lon: "", accuracy: "" });
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const applyFix = (next: Fix) => {
    setFix(next);
    setCoords({ lat: next.lat.toFixed(6), lon: next.lon.toFixed(6), accuracy: next.accuracy === null ? "" : String(Math.round(next.accuracy)) });
  };

  useEffect(() => {
    setDevice({ id: deviceId(), os: deviceOs() });
    locate(applyFix, () => setMessage("Your location is not available. Enter it by hand below."));
  }, []);

  function addPhotos(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    const added = files.map((file) => ({ file, capturedAt: new Date(file.lastModified).toISOString(), fix }));
    setPhotos((current) => [...current, ...added].slice(0, maxPhotos));
    event.target.value = "";
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const result = await postForm<{ activationId: string }>("/api/agent/activations", buildForm(event.currentTarget, photos, device));
    setBusy(false);
    if (!result.ok) {
      setErrors(result.fieldErrors);
      setMessage(result.message);
      return;
    }
    router.push(`/agent/activations/${result.data.activationId}`);
    router.refresh();
  }

  return (
    <form className="stack-lg" onSubmit={submit} noValidate>
      <input type="hidden" name="assignmentId" value={assignmentId} />
      {message && <div className="alert error" role="alert">{message}</div>}

      <fieldset className="stack">
        <legend>The customer</legend>
        <div className="field">
          <label htmlFor="customerMsisdn">Customer&rsquo;s phone number</label>
          <input id="customerMsisdn" name="customerMsisdn" className="input" inputMode="tel" placeholder="0712 345 678" />
          <span className="hint">Stored only as a one-way code; nobody can read the number back.</span>
          <FieldError errors={errors} name="customerMsisdn" />
        </div>
        <div className="field">
          <label htmlFor="simRegisteredAt">SIM registration date</label>
          <input id="simRegisteredAt" name="simRegisteredAt" type="date" className="input" />
          <FieldError errors={errors} name="simRegisteredAt" />
        </div>
        <div className="field">
          <span className="label">How did you capture the details?</span>
          <label className="row small"><input type="radio" name="activationMethod" value="qr_scan" defaultChecked /> Scanned the code on the SIM pack</label>
          <label className="row small"><input type="radio" name="activationMethod" value="manual_entry" /> Typed them in by hand</label>
        </div>
      </fieldset>

      <fieldset className="stack">
        <legend>Evidence</legend>
        <div className="field">
          <label htmlFor="photoInput">Photos ({photos.length} of up to {maxPhotos})</label>
          <input id="photoInput" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" capture="environment" multiple onChange={addPhotos} />
          <span className="hint">Each photo is stamped with its file time and your current location{fix ? "" : " (location unavailable, so photos will have none)"}.</span>
          <FieldError errors={errors} name="photos" />
        </div>
        {photos.length > 0 && (
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {photos.map((photo, index) => (
              <li key={index}>
                Photo {index + 1}: {photo.file.name} {photo.fix ? `(${photo.fix.lat.toFixed(4)}, ${photo.fix.lon.toFixed(4)})` : "(no location)"}{" "}
                <button type="button" className="linkbutton" onClick={() => setPhotos(photos.filter((_, i) => i !== index))}>remove</button>
              </li>
            ))}
          </ul>
        )}
        <div className="field">
          <label htmlFor="proof">Proof of activation (optional)</label>
          <input id="proof" name="proof" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" />
          <span className="hint">For example a photo of the activation confirmation message.</span>
        </div>
        <div className="field">
          <label htmlFor="agentNote">Note for the reviewer (optional)</label>
          <textarea id="agentNote" name="agentNote" className="textarea" maxLength={1000} />
        </div>
      </fieldset>

      <fieldset className="stack">
        <legend>Where you are</legend>
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
