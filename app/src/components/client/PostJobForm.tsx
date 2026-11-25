"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { postJson, type FieldErrors } from "@/lib/client-api";
import { differenceCents, formatCents, MoneyError, parseKshToCents, parsePercentToBps } from "@/lib/money/cents";
import { commissionDerivation, computeCommission, liabilityDerivation, maxLiability } from "@/lib/money/commission";
import { REVIEW_SETTING_EFFECT } from "@/lib/review/effect";
import { groupKsh } from "@/lib/ui/format";
import { ChoiceGroup } from "@/components/ChoiceGroup";
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
type Terms = { value: string; rate: string; flat: string; slots: string };

/** API field (integer units) -> the form field it came from (shillings or per cent). */
const FIELD_FOR: Record<string, string> = {
  submissionValueCents: "submissionValueKsh",
  commissionRateBps: "commissionRatePercent",
  flatCommissionCents: "flatCommissionKsh",
};

type Parsed = { submissionValueCents: number; commissionRateBps: number; flatCommissionCents: number; slots: number };

/** Converts the typed terms to integer units, or returns an error per field. */
function parseTerms(terms: Terms): { parsed: Parsed | null; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const value = parseKshToCents(terms.value);
  const rate = parsePercentToBps(terms.rate);
  const flat = terms.flat.trim() === "" ? 0 : parseKshToCents(terms.flat);
  const slots = /^\d{1,5}$/.test(terms.slots.trim()) ? Number(terms.slots.trim()) : null;
  if (value === null || value === 0) errors.submissionValueKsh = "Enter the value in shillings, with at most two decimal places.";
  if (rate === null || rate === 0) errors.commissionRatePercent = "Enter a rate from 0.01 to 100, with at most two decimal places.";
  if (flat === null) errors.flatCommissionKsh = "Enter shillings with at most two decimal places, or leave it empty.";
  if (slots === null || slots === 0) errors.slots = "Enter a whole number of activations.";
  if (Object.keys(errors).length > 0) return { parsed: null, errors };
  return {
    parsed: { submissionValueCents: value!, commissionRateBps: rate!, flatCommissionCents: flat!, slots: slots! },
    errors,
  };
}

/** Live preview: commission per approved submission and the amount publication will lock, with derivations. */
export function Preview({ terms, availableCents }: { terms: Terms; availableCents: number }) {
  const { parsed } = parseTerms(terms);
  if (!parsed) {
    return (
      <div className="stack-sm">
        <p className="small muted">Enter the value, rate and number of activations to see the commission and what publishing will lock.</p>
        <div className="small muted">Available now: {formatCents(availableCents)}.</div>
      </div>
    );
  }
  try {
    const commission = computeCommission(parsed);
    const liability = maxLiability(parsed, parsed.slots);
    const short = liability.amountCents > availableCents;
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
          Available now: {formatCents(availableCents)}.
          {short ? ` Publishing will be refused: fund your escrow with at least ${formatCents(differenceCents(liability.amountCents, availableCents))} more first.` : ""}
        </div>
      </div>
    );
  } catch (error) {
    if (error instanceof MoneyError) return <div className="alert warn">{error.message}</div>;
    throw error;
  }
}

/**
 * Defaults, so a first-time client has fewer fields to fill. Assumptions, not
 * measured figures: ten activations, a 10% rate, a 700 m radius, and a 30-day
 * deadline (set by the page). Money fields that depend on the client's own
 * business (the value of a sign-up, any flat amount) stay empty.
 */
export const DEFAULT_SLOTS = "10";
export const DEFAULT_RATE_PERCENT = "10";
export const DEFAULT_RADIUS_M = "700";

/** The form's choices for one job, and what each sends: "" follows the account setting. */
export const REVIEW_CHOICES: Record<string, boolean | null> = { "": null, on: true, off: false };

export function ReviewChoice({ accountSetting }: { accountSetting: boolean }) {
  const options = [
    { value: "", label: `Use my account setting (currently ${accountSetting ? "on" : "off"})` },
    { value: "on", label: "On for this job" },
    { value: "off", label: "Off for this job" },
  ];
  return (
    <div className="field">
      <span className="label" id="reviewChoice-label">Require a reviewer before any payment on this job</span>
      <ChoiceGroup name="reviewChoice" options={options} labelledBy="reviewChoice-label" defaultValue="" />
      <span className="hint">{REVIEW_SETTING_EFFECT} This job&rsquo;s choice cannot be changed once published.</span>
    </div>
  );
}

/** The unit drawn inside each money or rate box; the label names it too. */
const AFFIX: Partial<Record<keyof Terms, { side: "prefix" | "suffix"; text: string }>> = {
  value: { side: "prefix", text: "KSh" },
  flat: { side: "prefix", text: "KSh" },
  rate: { side: "suffix", text: "%" },
};

/** Shilling fields regroup with thousands separators when left (the parser accepts them). */
const SHILLINGS: ReadonlyArray<keyof Terms> = ["value", "flat"];

/** Post a job, in four groups: the job, the evidence, the area and the commission. A summary of the money stays in view. */
export function PostJobForm({ availableCents, defaultDeadline, accountReviewSetting }: { availableCents: number; defaultDeadline: string; accountReviewSetting: boolean }) {
  const router = useRouter();
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [centre, setCentre] = useState({ lat: "", lon: "" });
  const [terms, setTerms] = useState<Terms>({ value: "", rate: DEFAULT_RATE_PERCENT, flat: "", slots: DEFAULT_SLOTS });
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
      reviewAllSubmissions: REVIEW_CHOICES[String(form.reviewChoice)],
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
    router.push(`/client/jobs/${result.data.jobId}?posted=1`);
    router.refresh();
  }

  const termInput = (key: keyof Terms, name: string, label: string, hint?: string) => {
    const affix = AFFIX[key];
    const input = (
      <input
        id={name}
        name={name}
        className="input"
        inputMode="decimal"
        value={terms[key]}
        onChange={(e) => setTerms({ ...terms, [key]: e.target.value })}
        onBlur={SHILLINGS.includes(key) ? (e) => setTerms({ ...terms, [key]: groupKsh(e.target.value) }) : undefined}
      />
    );
    return (
      <div className="field">
        <label htmlFor={name}>{label}</label>
        {affix ? <div className={`affix ${affix.side}`}><span className="affix-text" aria-hidden="true">{affix.text}</span>{input}</div> : input}
        {hint && <span className="hint">{hint}</span>}
        <FieldError errors={errors} name={name} />
      </div>
    );
  };

  return (
    <form className="post-layout" onSubmit={submit} noValidate>
      <div className="stack-lg">
        {message && <div className="alert error" role="alert">{message}</div>}
        <fieldset className="form-group stack">
          <legend>1. The job</legend>
          <Field name="title" label="Title" errors={errors} hint="For example: SIM registration drive, Gikomba Market" />
          <div className="field">
            <label htmlFor="description">What agents should do</label>
            <textarea id="description" name="description" className="textarea" />
            <FieldError errors={errors} name="description" />
          </div>
          <Field name="deadline" label="Deadline" type="date" defaultValue={defaultDeadline} errors={errors} hint="The last day work is accepted, 30 days from today unless you change it. After it, no new assignments or submissions; it cannot be changed once published." />
          <ReviewChoice accountSetting={accountReviewSetting} />
        </fieldset>
        <fieldset className="form-group stack">
          <legend>2. Evidence the agent must submit</legend>
          <p className="hint" style={{ margin: 0 }}>Optional: add anything else you want the agent to record.</p>
          <details className="help-more">
            <summary className="small">How evidence fields work</summary>
            <p className="hint">
              Every submission already records the customer&rsquo;s number, SIM date, capture method and optional proof. Add fields here
              for anything else you want checked; the capture form is built from them, in this order. You can change them later; submissions
              already made stay judged by the fields in force when they were made. They are for your checks and the reviewer&rsquo;s, never given
              to the fraud model.
            </p>
          </details>
          <EvidenceFieldsEditor rows={fields} onChange={setFields} errors={errors} />
        </fieldset>
        <fieldset className="form-group stack">
          <legend>3. Job area</legend>
          <Field name="areaName" label="Place name" errors={errors} />
          <div className="grid-3">
            <div className="field"><label htmlFor="areaLat">Centre latitude</label><input id="areaLat" name="areaLat" className="input" value={centre.lat} onChange={(e) => setCentre({ ...centre, lat: e.target.value })} /><FieldError errors={errors} name="areaLat" /></div>
            <div className="field"><label htmlFor="areaLon">Centre longitude</label><input id="areaLon" name="areaLon" className="input" value={centre.lon} onChange={(e) => setCentre({ ...centre, lon: e.target.value })} /><FieldError errors={errors} name="areaLon" /></div>
            <Field name="areaRadiusM" label="Radius (metres)" errors={errors} defaultValue={DEFAULT_RADIUS_M} inputMode="numeric" />
          </div>
          <button type="button" className="btn small" onClick={useMyLocation} style={{ alignSelf: "flex-start" }}>Use my current location as the centre</button>
          <span className="hint">Photos taken outside this circle are flagged to the reviewer.</span>
        </fieldset>
        <fieldset className="form-group stack">
          <legend>4. Commission</legend>
          <div className="grid-2">
            {termInput("value", "submissionValueKsh", "Value of one approved submission (KSh)", "What one sign-up is worth to you.")}
            {termInput("rate", "commissionRatePercent", "Commission rate (%)", "Applied to the value, rounded down to the cent.")}
            {termInput("flat", "flatCommissionKsh", "Flat amount per approved submission (KSh, optional)")}
            {termInput("slots", "slots", "Activations wanted", "How many sign-ups you want. Publishing locks the most this could cost.")}
          </div>
        </fieldset>
      </div>
      <aside className="post-summary card card-pad stack" aria-labelledby="summary-heading">
        <h2 id="summary-heading">Commission summary</h2>
        <Preview terms={terms} availableCents={availableCents} />
        <button type="submit" className="btn primary block" disabled={busy}>{busy ? "Publishing" : "Publish the job"}</button>
        <p className="tiny muted">Agents are assigned by a reviewer after you publish.</p>
      </aside>
    </form>
  );
}
