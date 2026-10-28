"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { postJson, type FieldErrors } from "@/lib/client-api";

function FieldError({ errors, name }: { errors: FieldErrors; name: string }) {
  return errors[name] ? <span className="field-error">{errors[name]}</span> : null;
}

function Field(props: { name: string; label: string; errors: FieldErrors; hint?: string; type?: string; defaultValue?: string; inputMode?: "decimal" | "numeric" }) {
  return (
    <div className="field">
      <label htmlFor={props.name}>{props.label}</label>
      <input id={props.name} name={props.name} className="input" type={props.type ?? "text"} defaultValue={props.defaultValue} inputMode={props.inputMode} />
      {props.hint && <span className="hint">{props.hint}</span>}
      <FieldError errors={props.errors} name={props.name} />
    </div>
  );
}

/** Post a job with its area, payout, slots and optional first deposit. */
export function PostJobForm() {
  const router = useRouter();
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [centre, setCentre] = useState({ lat: "", lon: "" });

  function useMyLocation() {
    navigator.geolocation?.getCurrentPosition(
      (p) => setCentre({ lat: p.coords.latitude.toFixed(5), lon: p.coords.longitude.toFixed(5) }),
      () => setMessage("Location is not available in this browser. Enter the centre by hand."),
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setMessage(null);
    const result = await postJson<{ jobId: string }>("/api/client/jobs", body);
    setBusy(false);
    if (!result.ok) {
      setErrors(result.fieldErrors);
      setMessage(result.message);
      return;
    }
    router.push(`/client/jobs/${result.data.jobId}`);
    router.refresh();
  }

  return (
    <form className="stack-lg" onSubmit={submit} noValidate>
      {message && <div className="alert error" role="alert">{message}</div>}
      <fieldset className="stack">
        <legend>The job</legend>
        <Field name="title" label="Title" errors={errors} hint="For example: SIM registration drive, Gikomba Market" />
        <div className="field">
          <label htmlFor="description">What agents should do</label>
          <textarea id="description" name="description" className="textarea" />
          <FieldError errors={errors} name="description" />
        </div>
      </fieldset>
      <fieldset className="stack">
        <legend>Job area</legend>
        <Field name="areaName" label="Place name" errors={errors} />
        <div className="grid-3">
          <div className="field"><label htmlFor="areaLat">Centre latitude</label><input id="areaLat" name="areaLat" className="input" value={centre.lat} onChange={(e) => setCentre({ ...centre, lat: e.target.value })} /><FieldError errors={errors} name="areaLat" /></div>
          <div className="field"><label htmlFor="areaLon">Centre longitude</label><input id="areaLon" name="areaLon" className="input" value={centre.lon} onChange={(e) => setCentre({ ...centre, lon: e.target.value })} /><FieldError errors={errors} name="areaLon" /></div>
          <Field name="areaRadiusM" label="Radius (metres)" errors={errors} defaultValue="700" inputMode="numeric" />
        </div>
        <button type="button" className="btn small" onClick={useMyLocation} style={{ alignSelf: "flex-start" }}>Use my current location as the centre</button>
        <span className="hint">Photos taken outside this circle are flagged to the reviewer.</span>
      </fieldset>
      <fieldset className="stack">
        <legend>Pay and escrow</legend>
        <div className="grid-3">
          <Field name="payoutPerActivationKsh" label="Payout per activation (KSh)" errors={errors} inputMode="numeric" />
          <Field name="commissionRatePercent" label="Commission rate (%)" errors={errors} defaultValue="10" inputMode="decimal" />
          <Field name="slots" label="Activations wanted" errors={errors} inputMode="numeric" />
        </div>
        <Field name="initialFundingKsh" label="Deposit into escrow now (KSh, optional)" errors={errors} defaultValue="0" inputMode="numeric" hint="Each assignment locks one payout's worth of escrow. You can add more later." />
      </fieldset>
      <button type="submit" className="btn primary" disabled={busy}>{busy ? "Posting" : "Post the job"}</button>
    </form>
  );
}
