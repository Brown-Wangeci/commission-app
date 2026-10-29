"use client";

import { describeFormat, FIELD_TYPE_LABELS, FIELD_TYPES, TEXT_PATTERNS, type FieldDefinition, type FieldInput, type FieldType, type TextPattern } from "@/lib/evidence/fields";

/**
 * The client's evidence field editor (FR-05, issue #46): an ordered list of
 * fields, each with a label, a type, whether it is mandatory, and the
 * expected format of its value. Every type keeps its own format settings, so
 * switching a field's type and back loses nothing.
 */
export type EditorRow = {
  key?: string;
  label: string;
  type: FieldType;
  mandatory: boolean;
  help: string;
  text: { pattern: TextPattern; minLength: string; maxLength: string };
  number: { decimals: string; min: string; max: string };
  date: { allowFuture: boolean };
  options: string;
  photo: { minCount: string; maxCount: string };
};

export function blankRow(type: FieldType = "text"): EditorRow {
  return {
    label: "",
    type,
    mandatory: true,
    help: "",
    text: { pattern: "any", minLength: "0", maxLength: "200" },
    number: { decimals: "0", min: "", max: "" },
    date: { allowFuture: false },
    options: "",
    photo: { minCount: "1", maxCount: "3" },
  };
}

export function rowsFromDefinitions(fields: FieldDefinition[]): EditorRow[] {
  return fields.map((field) => {
    const row: EditorRow = { ...blankRow(field.type), key: field.key, label: field.label, mandatory: field.mandatory, help: field.help ?? "" };
    if (field.type === "text") row.text = { pattern: field.format.pattern, minLength: String(field.format.minLength), maxLength: String(field.format.maxLength) };
    if (field.type === "number") row.number = { decimals: String(field.format.decimals), min: field.format.min === null ? "" : String(field.format.min), max: field.format.max === null ? "" : String(field.format.max) };
    if (field.type === "date") row.date = { allowFuture: field.format.allowFuture };
    if (field.type === "single_select") row.options = field.format.options.map((o) => o.label).join("\n");
    if (field.type === "photo") row.photo = { minCount: String(field.format.minCount), maxCount: String(field.format.maxCount) };
    return row;
  });
}

function whole(text: string): number {
  return /^\d+$/.test(text.trim()) ? Number(text.trim()) : Number.NaN;
}

function bound(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  return /^-?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/** The row as the API takes it. Anything malformed is sent as-is, for the server to name. */
export function toFieldInput(row: EditorRow): FieldInput {
  const common = { key: row.key, label: row.label, mandatory: row.mandatory, help: row.help.trim() || null };
  switch (row.type) {
    case "text":
      return { ...common, type: "text", format: { pattern: row.text.pattern, minLength: whole(row.text.minLength), maxLength: whole(row.text.maxLength) } };
    case "number":
      return { ...common, type: "number", format: { decimals: whole(row.number.decimals), min: bound(row.number.min), max: bound(row.number.max) } };
    case "date":
      return { ...common, type: "date", format: { allowFuture: row.date.allowFuture } };
    case "single_select": {
      const labels = row.options.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      return { ...common, type: "single_select", format: { options: labels.map((label) => ({ value: label, label })) } };
    }
    case "phone":
      return { ...common, type: "phone", format: { country: "KE" } };
    case "photo": {
      const maxCount = whole(row.photo.maxCount);
      return { ...common, type: "photo", format: { minCount: row.mandatory ? whole(row.photo.minCount) : 0, maxCount } };
    }
  }
}

function preview(row: EditorRow): string | null {
  try {
    const input = toFieldInput(row);
    return describeFormat({ ...input, key: "preview", help: null } as FieldDefinition);
  } catch {
    return null;
  }
}

type Props = {
  rows: EditorRow[];
  onChange: (rows: EditorRow[]) => void;
  /** Error messages keyed by API path, e.g. "evidenceFields.2.format". */
  errors: Record<string, string>;
};

function FormatControls({ row, update }: { row: EditorRow; update: (patch: Partial<EditorRow>) => void }) {
  switch (row.type) {
    case "text":
      return (
        <div className="grid-3">
          <div className="field">
            <label>Allowed characters</label>
            <select className="select" value={row.text.pattern} onChange={(e) => update({ text: { ...row.text, pattern: e.target.value as TextPattern } })}>
              {Object.entries(TEXT_PATTERNS).map(([value, pattern]) => <option key={value} value={value}>{pattern.label}</option>)}
            </select>
          </div>
          <div className="field"><label>Shortest</label><input className="input" inputMode="numeric" value={row.text.minLength} onChange={(e) => update({ text: { ...row.text, minLength: e.target.value } })} /></div>
          <div className="field"><label>Longest</label><input className="input" inputMode="numeric" value={row.text.maxLength} onChange={(e) => update({ text: { ...row.text, maxLength: e.target.value } })} /></div>
        </div>
      );
    case "number":
      return (
        <div className="grid-3">
          <div className="field">
            <label>Decimal places</label>
            <select className="select" value={row.number.decimals} onChange={(e) => update({ number: { ...row.number, decimals: e.target.value } })}>
              {["0", "1", "2", "3", "4"].map((d) => <option key={d} value={d}>{d === "0" ? "Whole numbers only" : `Up to ${d}`}</option>)}
            </select>
          </div>
          <div className="field"><label>Smallest (optional)</label><input className="input" inputMode="decimal" value={row.number.min} onChange={(e) => update({ number: { ...row.number, min: e.target.value } })} /></div>
          <div className="field"><label>Largest (optional)</label><input className="input" inputMode="decimal" value={row.number.max} onChange={(e) => update({ number: { ...row.number, max: e.target.value } })} /></div>
        </div>
      );
    case "date":
      return <label className="row small"><input type="checkbox" checked={row.date.allowFuture} onChange={(e) => update({ date: { allowFuture: e.target.checked } })} /> Allow dates in the future</label>;
    case "single_select":
      return (
        <div className="field">
          <label>Options, one per line</label>
          <textarea className="textarea" value={row.options} onChange={(e) => update({ options: e.target.value })} />
        </div>
      );
    case "phone":
      return <p className="hint" style={{ margin: 0 }}>Accepts Kenyan mobile numbers (07.., 01.., +254..).</p>;
    case "photo":
      return (
        <div className="grid-3">
          {row.mandatory && <div className="field"><label>Fewest photos</label><input className="input" inputMode="numeric" value={row.photo.minCount} onChange={(e) => update({ photo: { ...row.photo, minCount: e.target.value } })} /></div>}
          <div className="field"><label>Most photos</label><input className="input" inputMode="numeric" value={row.photo.maxCount} onChange={(e) => update({ photo: { ...row.photo, maxCount: e.target.value } })} /></div>
        </div>
      );
  }
}

export function EvidenceFieldsEditor({ rows, onChange, errors }: Props) {
  const update = (index: number, patch: Partial<EditorRow>) => onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const move = (index: number, by: number) => {
    const next = [...rows];
    const [row] = next.splice(index, 1);
    next.splice(index + by, 0, row);
    onChange(next);
  };
  const rowErrors = (index: number) => Object.entries(errors).filter(([path]) => path === `evidenceFields.${index}` || path.startsWith(`evidenceFields.${index}.`)).map(([, message]) => message);
  return (
    <div className="stack">
      {errors.evidenceFields && <span className="field-error">{errors.evidenceFields}</span>}
      {rows.length === 0 && <p className="small muted">No job-specific fields yet. Every activation still records the customer&rsquo;s number, SIM date, capture method and optional proof.</p>}
      {rows.map((row, index) => (
        <div key={index} className="card card-pad stack-sm" style={{ background: "var(--surface-muted)" }}>
          <div className="row-between wrap" style={{ gap: 8 }}>
            <strong className="small">Field {index + 1}{row.key ? <span className="muted mono"> {row.key}</span> : null}</strong>
            <div className="row" style={{ gap: 6 }}>
              <button type="button" className="btn small" onClick={() => move(index, -1)} disabled={index === 0}>Up</button>
              <button type="button" className="btn small" onClick={() => move(index, 1)} disabled={index === rows.length - 1}>Down</button>
              <button type="button" className="btn small danger" onClick={() => onChange(rows.filter((_, i) => i !== index))}>Remove</button>
            </div>
          </div>
          <div className="grid-3">
            <div className="field"><label>Label</label><input className="input" value={row.label} onChange={(e) => update(index, { label: e.target.value })} /></div>
            <div className="field">
              <label>Type</label>
              <select className="select" value={row.type} onChange={(e) => update(index, { type: e.target.value as FieldType })}>
                {FIELD_TYPES.map((type) => <option key={type} value={type}>{FIELD_TYPE_LABELS[type]}</option>)}
              </select>
            </div>
            <label className="row small" style={{ alignSelf: "end", paddingBottom: 10 }}>
              <input type="checkbox" checked={row.mandatory} onChange={(e) => update(index, { mandatory: e.target.checked })} /> Mandatory
            </label>
          </div>
          <FormatControls row={row} update={(patch) => update(index, patch)} />
          <div className="field"><label>Help for the agent (optional)</label><input className="input" value={row.help} onChange={(e) => update(index, { help: e.target.value })} /></div>
          {preview(row) && <span className="hint">Expected: {preview(row)}</span>}
          {rowErrors(index).map((message, i) => <span key={i} className="field-error">{message}</span>)}
        </div>
      ))}
      <div className="row wrap" style={{ gap: 6 }}>
        {FIELD_TYPES.map((type) => (
          <button key={type} type="button" className="btn small" onClick={() => onChange([...rows, blankRow(type)])}>+ {FIELD_TYPE_LABELS[type]}</button>
        ))}
      </div>
    </div>
  );
}
