"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { postJson, type FieldErrors } from "@/lib/client-api";
import { differenceCents, formatCents, MoneyError, parseKshToCents, parsePercentToBps, sumCents } from "@/lib/money/cents";
import { commissionDerivation, computeCommission, liabilityDerivation, maxLiability } from "@/lib/money/commission";
import { EvidenceFieldsEditor, toFieldInput, type EditorRow } from "./EvidenceFieldsEditor";

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

/** The money fields as typed, in shillings and per cent. */
type Terms = { value: string; rate: string; flat: string; slots: string; deposit: string };

/** API field (integer units) -> the form field it came from (shillings or per cent). */
const FIELD_FOR: Record<string, string> = {
  submissionValueCents: "submissionValueKsh",
  commissionRateBps: "commissionRatePercent",
  flatCommissionCents: "flatCommissionKsh",
  initialDepositCents: "initialDepositKsh",
};

type Parsed = { submissionValueCents: number; commissionRateBps: number; flatCommissionCents: number; slots: number; initialDepositCents: number };

/** Converts the typed terms to integer units, or returns an error per field. */
function parseTerms(terms: Terms): { parsed: Parsed | null; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const value = parseKshToCents(terms.value);
  const rate = parsePercentToBps(terms.rate);
  const flat = terms.flat.trim() === "" ? 0 : parseKshToCents(terms.flat);
  const deposit = terms.deposit.trim() === "" ? 0 : parseKshToCents(terms.deposit);
  const slots = /^\d{1,5}$/.test(terms.slots.trim()) ? Number(terms.slots.trim()) : null;
  if (value === null || value === 0) errors.submissionValueKsh = "Enter the value in shillings, with at most two decimal places.";
  if (rate === null || rate === 0) errors.commissionRatePercent = "Enter a rate from 0.01 to 100, with at most two decimal places.";
  if (flat === null) errors.flatCommissionKsh = "Enter shillings with at most two decimal places, or leave it empty.";
  if (deposit === null) errors.initialDepositKsh = "Enter shillings with at most two decimal places, or leave it empty.";
  if (slots === null || slots === 0) errors.slots = "Enter a whole number of activations.";
  if (Object.keys(errors).length > 0) return { parsed: null, errors };
  return {
    parsed: { submissionValueCents: value!, commissionRateBps: rate!, flatCommissionCents: flat!, slots: slots!, initialDepositCents: deposit! },
    errors,
  };
}

/** Live preview: commission per approved submission and the amount publication will lock, with derivations. */
function Preview({ terms, availableCents }: { terms: Terms; availableCents: number }) {
  const { parsed } = parseTerms(terms);
  if (!parsed) return <p className="small muted">Enter the value, rate and number of activations to see the commission and what publishing will lock.</p>;
  try {
    const commission = computeCommission(parsed);
    const liability = maxLiability(parsed, parsed.slots);
    const availableAfterDeposit = sumCents([availableCents, parsed.initialDepositCents]);
    const short = liability.amountCents > availableAfterDeposit;
    return (
      <div className="stack-sm">
        <div>
          <div className="stat-label">Commission per approved submission</div>
          <div className="strong num">{formatCents(commission.amountCents)}</div>
          <span className="derivation">{commissionDerivation(commission)}</span>
        </div>
        <div>
          <div className="stat-label">Locked from your escrow when you publish</div>
          <div className="strong num">{formatCents(liability.amountCents)}</div>
          <span className="derivation">{liabilityDerivation(liability)}</span>
        </div>
        <div className={short ? "alert warn" : "small muted"}>
          Available {parsed.initialDepositCents > 0 ? "after this deposit" : "now"}: {formatCents(availableAfterDeposit)}.
          {short ? ` Publishing will be refused: deposit at least ${formatCents(differenceCents(liability.amountCents, availableAfterDeposit))} more.` : ""}
        </div>
      </div>
    );
  } catch (error) {
    if (error instanceof MoneyError) return <div className="alert warn">{error.message}</div>;
    throw error;
  }
}

/** Post a job: its area, its commission structure, how many activations, and an optional deposit. */
export function PostJobForm({ availableCents }: { availableCents: number }) {
  const router = useRouter();
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [centre, setCentre] = useState({ lat: "", lon: "" });
  const [terms, setTerms] = useState<Terms>({ value: "", rate: "10", flat: "", slots: "", deposit: "" });
  const [fields, setFields] = useState<EditorRow[]>([]);

  function useMyLocation() {
    navigator.geolocation?.getCurrentPosition(
      (p) => setCentre({ lat: p.coords.latitude.toFixed(5), lon: p.coords.longitude.toFixed(5) }),
      () => setMessage("Location is not available in this browser. Enter the centre by hand."),
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    const { parsed, errors: termErrors } = parseTerms(terms);
    if (!parsed) {
      setErrors(termErrors);
      setMessage("Some fields are missing or invalid.");
      return;
    }
    const body = {
      title: form.title,
      description: form.description,
      areaName: form.areaName,
      areaLat: form.areaLat,
      areaLon: form.areaLon,
      areaRadiusM: form.areaRadiusM,
      deadline: form.deadline,
      evidenceFields: fields.map(toFieldInput),
      ...parsed,
    };
    setBusy(true);
    setMessage(null);
    const result = await postJson<{ jobId: string }>("/api/client/jobs", body);
    setBusy(false);
    if (!result.ok) {
      setErrors(Object.fromEntries(Object.entries(result.fieldErrors).map(([field, text]) => [FIELD_FOR[field] ?? field, text])));
      setMessage(result.message);
      return;
    }
    router.push(`/client/jobs/${result.data.jobId}`);
    router.refresh();
  }

  const termInput = (key: keyof Terms, name: string, label: string, hint?: string) => (
    <div className="field">
      <label htmlFor={name}>{label}</label>
      <input id={name} name={name} className="input" inputMode="decimal" value={terms[key]} onChange={(e) => setTerms({ ...terms, [key]: e.target.value })} />
      {hint && <span className="hint">{hint}</span>}
      <FieldError errors={errors} name={name} />
    </div>
  );

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
        <Field name="deadline" label="Deadline" type="date" errors={errors} hint="The last day work is accepted. After it, no new assignments or submissions; the deadline cannot be changed once published." />
      </fieldset>
      <fieldset className="stack">
        <legend>Evidence the agent must submit</legend>
        <p className="hint" style={{ margin: 0 }}>
          The capture form is built from these fields, in this order, and every submission is checked against them. You can change them
          later; submissions already made stay judged by the fields in force when they were made. These fields are for your checks and the
          reviewer&rsquo;s; they are never given to the fraud model.
        </p>
        <EvidenceFieldsEditor rows={fields} onChange={setFields} errors={errors} />
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
        <legend>Commission</legend>
        <div className="grid-3">
          {termInput("value", "submissionValueKsh", "Value of one approved submission (KSh)", "What one sign-up is worth to you.")}
          {termInput("rate", "commissionRatePercent", "Commission rate (%)", "Applied to the value, rounded down to the cent.")}
          {termInput("flat", "flatCommissionKsh", "Flat amount per approved submission (KSh, optional)")}
        </div>
        <div className="grid-3">
          {termInput("slots", "slots", "Activations wanted")}
          {termInput("deposit", "initialDepositKsh", "Deposit into escrow now (KSh, optional)")}
        </div>
        <Preview terms={terms} availableCents={availableCents} />
      </fieldset>
      <button type="submit" className="btn primary" disabled={busy}>{busy ? "Publishing" : "Publish the job"}</button>
    </form>
  );
}
