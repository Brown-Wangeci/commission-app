import { z } from "zod";
import { normaliseMsisdn } from "@/lib/validation";

/**
 * Evidence field definitions and their validation (FR-05, FR-09, FR-12,
 * issues #46 to #48). One definition describes one field an agent completes:
 * its label, type, whether it is mandatory and the expected format of its
 * value. A job's evidence configuration is an ordered list of definitions,
 * stored as JSON and versioned (src/lib/evidence/config.ts); the platform's
 * own fields use the same definitions (src/lib/evidence/platform.ts).
 *
 * This module has no server dependencies: the capture form runs the same
 * validation in the browser to show errors early, and the server runs it
 * again on every submission, which is the check that counts.
 *
 * There is deliberately no currency type: an evidence field is information
 * about the work, never money the platform holds or moves, so it cannot slip
 * past the integer-cents rules for money (issue #40).
 */

export const FIELD_TYPES = ["text", "number", "date", "single_select", "phone", "photo"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  single_select: "Choice from a list",
  phone: "Phone number",
  photo: "Photo",
};

/** The largest number of photos one job's fields may ask for in total. */
export const MAX_JOB_PHOTOS = 12;
export const MAX_FIELDS = 20;
const MAX_TEXT_LENGTH = 500;

export const TEXT_PATTERNS = {
  any: { label: "Any text", regex: null },
  digits: { label: "Digits only", regex: /^[0-9]+$/ },
  letters_digits: { label: "Letters and digits only", regex: /^[A-Za-z0-9]+$/ },
  code: { label: "Letters, digits and hyphens", regex: /^[A-Za-z0-9-]+$/ },
} as const;
export type TextPattern = keyof typeof TEXT_PATTERNS;

export type TextFormat = { pattern: TextPattern; minLength: number; maxLength: number };
/** Up to `decimals` places after the point (0 means whole numbers only), within optional bounds. */
export type NumberFormat = { decimals: number; min: number | null; max: number | null };
export type DateFormat = { allowFuture: boolean };
export type SelectOption = { value: string; label: string };
export type SelectFormat = { options: SelectOption[] };
/** Kenyan mobile numbers only. */
export type PhoneFormat = { country: "KE" };
export type PhotoFormat = { minCount: number; maxCount: number };

type Base = { key: string; label: string; mandatory: boolean; help: string | null };
export type FieldDefinition =
  | (Base & { type: "text"; format: TextFormat })
  | (Base & { type: "number"; format: NumberFormat })
  | (Base & { type: "date"; format: DateFormat })
  | (Base & { type: "single_select"; format: SelectFormat })
  | (Base & { type: "phone"; format: PhoneFormat })
  | (Base & { type: "photo"; format: PhotoFormat });

/** A client-defined field's key: field_1, field_2 ... A key never changes meaning within one configuration version. */
export const CLIENT_KEY = /^field_[1-9][0-9]{0,2}$/;

// ------------------------------------------------------------------ schemas

const base = {
  key: z.string().regex(CLIENT_KEY, "Unknown field key.").optional(),
  label: z.string().trim().min(2, "Give the field a label of at least 2 characters.").max(80, "Keep the label under 80 characters."),
  mandatory: z.boolean(),
  help: z.string().trim().max(200, "Keep the help text under 200 characters.").nullish().transform((v) => (v ? v : null)),
};

const boundedNumber = z.number().finite().refine((v) => Math.abs(v) < 1e12, "Use a smaller number.");

const fieldInputSchema = z.discriminatedUnion("type", [
  z.object({
    ...base,
    type: z.literal("text"),
    format: z.object({
      pattern: z.enum(["any", "digits", "letters_digits", "code"]),
      minLength: z.number().int().min(0).max(MAX_TEXT_LENGTH),
      maxLength: z.number().int().min(1).max(MAX_TEXT_LENGTH),
    }),
  }),
  z.object({
    ...base,
    type: z.literal("number"),
    format: z.object({ decimals: z.number().int().min(0).max(4), min: boundedNumber.nullable(), max: boundedNumber.nullable() }),
  }),
  z.object({ ...base, type: z.literal("date"), format: z.object({ allowFuture: z.boolean() }) }),
  z.object({
    ...base,
    type: z.literal("single_select"),
    format: z.object({
      options: z
        .array(z.object({ value: z.string().trim().min(1).max(80), label: z.string().trim().min(1).max(80) }))
        .min(2, "Give at least 2 options.")
        .max(30, "Give at most 30 options."),
    }),
  }),
  z.object({ ...base, type: z.literal("phone"), format: z.object({ country: z.literal("KE") }) }),
  z.object({
    ...base,
    type: z.literal("photo"),
    format: z.object({ minCount: z.number().int().min(0).max(MAX_JOB_PHOTOS), maxCount: z.number().int().min(1).max(MAX_JOB_PHOTOS) }),
  }),
]);

export type FieldInput = z.input<typeof fieldInputSchema>;

function fieldProblems(field: z.infer<typeof fieldInputSchema>): string[] {
  const problems: string[] = [];
  const f = field.format as Record<string, unknown>;
  if (field.type === "text" && (f.minLength as number) > (f.maxLength as number)) problems.push("The shortest length is above the longest.");
  if (field.type === "number" && f.min !== null && f.max !== null && (f.min as number) > (f.max as number)) problems.push("The smallest value is above the largest.");
  if (field.type === "single_select") {
    const values = (f.options as SelectOption[]).map((o) => o.value.toLowerCase());
    if (new Set(values).size !== values.length) problems.push("Each option may appear once.");
  }
  if (field.type === "photo") {
    const { minCount, maxCount } = field.format;
    if (minCount > maxCount) problems.push("The fewest photos is above the most.");
    if (field.mandatory && minCount < 1) problems.push("A mandatory photo field needs at least 1 photo.");
    if (!field.mandatory && minCount > 0) problems.push("An optional photo field cannot require a minimum; make it mandatory instead.");
  }
  return problems;
}

/** A client's list of fields as submitted (keys optional for new fields). */
export const evidenceConfigInputSchema = z
  .array(fieldInputSchema)
  .max(MAX_FIELDS, `A job can have at most ${MAX_FIELDS} evidence fields.`)
  .superRefine((fields, ctx) => {
    const labels = new Set<string>();
    const keys = new Set<string>();
    let photos = 0;
    fields.forEach((field, index) => {
      for (const message of fieldProblems(field)) ctx.addIssue({ code: "custom", path: [index, "format"], message });
      const label = field.label.toLowerCase();
      if (labels.has(label)) ctx.addIssue({ code: "custom", path: [index, "label"], message: "Two fields cannot have the same label." });
      labels.add(label);
      if (field.key) {
        if (keys.has(field.key)) ctx.addIssue({ code: "custom", path: [index, "key"], message: "Two fields cannot share a key." });
        keys.add(field.key);
      }
      if (field.type === "photo") photos += field.format.maxCount;
    });
    if (photos > MAX_JOB_PHOTOS) {
      ctx.addIssue({ code: "custom", path: [], message: `The photo fields ask for up to ${photos} photos; the most a job can ask for is ${MAX_JOB_PHOTOS}.` });
    }
  });

/** Stored definitions: every field has a key. */
export const storedConfigSchema = z.array(fieldInputSchema.and(z.object({ key: z.string().min(1) })));

/**
 * Gives every new field a key (field_N, above any number already used in
 * this list or the previous version), keeping the keys of fields that have
 * one, so a field keeps its key from version to version.
 */
export function withKeys(fields: z.output<typeof evidenceConfigInputSchema>, previous: FieldDefinition[] = []): FieldDefinition[] {
  const used = [...fields.map((f) => f.key), ...previous.map((f) => f.key)].flatMap((key) => (key && CLIENT_KEY.test(key) ? [Number(key.slice(6))] : []));
  let next = used.length === 0 ? 1 : Math.max(...used) + 1;
  return fields.map((field) => ({ ...field, key: field.key ?? `field_${next++}` }) as FieldDefinition);
}

// ---------------------------------------------------------------- validation

export type EvidenceValue = string | number | number[];
export type FieldIssue = { key: string; label: string; message: string };
export type RawEvidence = {
  /** Every non-photo value as typed, by field key. */
  values: Record<string, string | undefined>;
  /** How many photos were attached to each photo field, by key. */
  photoCounts: Record<string, number>;
};
export type EvidenceResult =
  | { ok: true; values: Record<string, EvidenceValue> }
  | { ok: false; missing: string[]; issues: FieldIssue[] };

/** Today's date as YYYY-MM-DD in Kenya, the calendar dates are checked against. */
export function nairobiDate(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const KENYAN_MOBILE = /^(?:\+?254|0)(?:7|1)\d{8}$/;

/** One value against its field: the normalised value, or why it is wrong. */
function checkValue(field: FieldDefinition, value: string, today: string): { value: EvidenceValue } | { message: string } {
  switch (field.type) {
    case "text": {
      const { pattern, minLength, maxLength } = field.format;
      const length = [...value].length;
      if (CONTROL_CHARACTERS.test(value)) return { message: "Remove the control characters." };
      if (length < minLength) return { message: `Enter at least ${minLength} characters.` };
      if (length > maxLength) return { message: `Enter at most ${maxLength} characters.` };
      const regex = TEXT_PATTERNS[pattern].regex;
      if (regex && !regex.test(value)) return { message: `${TEXT_PATTERNS[pattern].label}.` };
      return { value };
    }
    case "number": {
      const { decimals, min, max } = field.format;
      const shape = decimals === 0 ? /^-?\d{1,15}$/ : new RegExp(`^-?\\d{1,15}(\\.\\d{1,${decimals}})?$`);
      if (!shape.test(value)) return { message: decimals === 0 ? "Enter a whole number." : `Enter a number with at most ${decimals} decimal place${decimals === 1 ? "" : "s"}.` };
      const number = Number(value);
      if (min !== null && number < min) return { message: `Enter ${min} or more.` };
      if (max !== null && number > max) return { message: `Enter ${max} or less.` };
      return { value: number };
    }
    case "date": {
      if (!isRealDate(value)) return { message: "Enter a real date as YYYY-MM-DD." };
      if (!field.format.allowFuture && value > today) return { message: "The date cannot be in the future." };
      return { value };
    }
    case "single_select": {
      const option = field.format.options.find((o) => o.value === value);
      return option ? { value: option.value } : { message: "Choose one of the listed options." };
    }
    case "phone": {
      const compact = value.replace(/[\s-]/g, "");
      return KENYAN_MOBILE.test(compact) ? { value: normaliseMsisdn(compact) } : { message: "Enter a Kenyan mobile number, e.g. 0712 345 678." };
    }
    case "photo":
      return { message: "A photo field takes photos, not a typed value." };
  }
}

function checkPhotos(field: Extract<FieldDefinition, { type: "photo" }>, count: number): string | null {
  const { minCount, maxCount } = field.format;
  if (count < minCount) return `Attach at least ${minCount} photo${minCount === 1 ? "" : "s"}.`;
  if (count > maxCount) return `Attach at most ${maxCount} photo${maxCount === 1 ? "" : "s"}.`;
  return null;
}

/**
 * Validates submitted evidence against a list of field definitions. Every
 * mandatory field left empty is named in `missing`; every failure, missing or
 * malformed, is reported against its own field in `issues`. Only the defined
 * fields are read: a value under any other key is ignored and never stored.
 */
export function validateEvidence(fields: FieldDefinition[], raw: RawEvidence, context: { today: string }): EvidenceResult {
  const values: Record<string, EvidenceValue> = {};
  const missing: string[] = [];
  const issues: FieldIssue[] = [];
  for (const field of fields) {
    if (field.type === "photo") {
      const count = raw.photoCounts[field.key] ?? 0;
      if (count === 0 && field.mandatory) {
        missing.push(field.label);
        issues.push({ key: field.key, label: field.label, message: "This field is mandatory." });
        continue;
      }
      const problem = checkPhotos(field, count);
      if (problem) issues.push({ key: field.key, label: field.label, message: problem });
      else if (count > 0) values[field.key] = count;
      continue;
    }
    const value = (raw.values[field.key] ?? "").trim();
    if (value === "") {
      if (field.mandatory) {
        missing.push(field.label);
        issues.push({ key: field.key, label: field.label, message: "This field is mandatory." });
      }
      continue;
    }
    const checked = checkValue(field, value, context.today);
    if ("message" in checked) issues.push({ key: field.key, label: field.label, message: checked.message });
    else values[field.key] = checked.value;
  }
  return issues.length === 0 ? { ok: true, values } : { ok: false, missing, issues };
}

// ------------------------------------------------------------------ display

/** The expected value format in words, for the form, the editor and the review screen. */
export function describeFormat(field: FieldDefinition): string {
  switch (field.type) {
    case "text": {
      const { pattern, minLength, maxLength } = field.format;
      const length = minLength > 0 ? `${minLength} to ${maxLength} characters` : `up to ${maxLength} characters`;
      return `${TEXT_PATTERNS[pattern].label}, ${length}`;
    }
    case "number": {
      const { decimals, min, max } = field.format;
      const kind = decimals === 0 ? "Whole number" : `Number with up to ${decimals} decimal place${decimals === 1 ? "" : "s"}`;
      if (min !== null && max !== null) return `${kind} from ${min} to ${max}`;
      if (min !== null) return `${kind}, ${min} or more`;
      if (max !== null) return `${kind}, ${max} or less`;
      return kind;
    }
    case "date":
      return field.format.allowFuture ? "Date (YYYY-MM-DD)" : "Date (YYYY-MM-DD), not in the future";
    case "single_select":
      return `One of: ${field.format.options.map((o) => o.label).join(", ")}`;
    case "phone":
      return "Kenyan mobile number, e.g. 0712 345 678";
    case "photo": {
      const { minCount, maxCount } = field.format;
      if (minCount === maxCount) return `Exactly ${maxCount} photo${maxCount === 1 ? "" : "s"}`;
      return minCount > 0 ? `${minCount} to ${maxCount} photos` : `Up to ${maxCount} photo${maxCount === 1 ? "" : "s"}`;
    }
  }
}

/** A stored value as a person reads it. Photos are shown as photos, not here. */
export function displayValue(field: FieldDefinition, value: EvidenceValue | undefined): string | null {
  if (value === undefined || field.type === "photo") return null;
  if (field.type === "single_select") return field.format.options.find((o) => o.value === value)?.label ?? String(value);
  if (field.type === "phone") return String(value).replace(/^(\d{4})(\d{3})(\d{3})$/, "$1 $2 $3");
  return String(value);
}
