import { describeFormat, displayValue, type EvidenceValue, type FieldType } from "./fields";
import type { ConfigVersion } from "./config";

/**
 * A submission's evidence as configured: one entry per field of the
 * configuration version it was validated against, in that version's order,
 * with that version's labels (FR-09, issue #50). A later edit to the job's
 * fields never relabels or hides what an earlier submission said.
 */
export type SubmittedField = {
  key: string;
  label: string;
  type: FieldType;
  mandatory: boolean;
  format: string;
  /** The value as a person reads it; null when not provided, and for photo fields. */
  value: string | null;
  /** The evidence numbers of a photo field's photos; null for other fields. */
  photoSequences: number[] | null;
};

export function submittedFields(config: ConfigVersion, payload: unknown): SubmittedField[] {
  const values = (payload && typeof payload === "object" ? payload : {}) as Record<string, EvidenceValue>;
  return config.fields.map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    mandatory: field.mandatory,
    format: describeFormat(field),
    value: displayValue(field, values[field.key]),
    photoSequences: field.type === "photo" ? (Array.isArray(values[field.key]) ? (values[field.key] as number[]) : []) : null,
  }));
}
