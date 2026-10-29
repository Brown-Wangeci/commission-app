import { describe, expect, it } from "vitest";
import {
  describeFormat,
  displayValue,
  evidenceConfigInputSchema,
  validateEvidence,
  withKeys,
  type FieldDefinition,
  type FieldInput,
} from "@/lib/evidence/fields";

/** One field of each type the client can choose (FR-05, issue #46). */
const FIELDS: FieldDefinition[] = [
  { key: "field_1", label: "SIM serial number", type: "text", mandatory: true, help: null, format: { pattern: "digits", minLength: 19, maxLength: 20 } },
  { key: "field_2", label: "Bundles sold", type: "number", mandatory: true, help: null, format: { decimals: 0, min: 1, max: 10 } },
  { key: "field_3", label: "Distance walked (km)", type: "number", mandatory: false, help: null, format: { decimals: 1, min: 0, max: null } },
  { key: "field_4", label: "Last top-up date", type: "date", mandatory: false, help: null, format: { allowFuture: false } },
  { key: "field_5", label: "ID document seen", type: "single_select", mandatory: true, help: null, format: { options: [{ value: "National ID", label: "National ID" }, { value: "Passport", label: "Passport" }] } },
  { key: "field_6", label: "Stall owner's number", type: "phone", mandatory: false, help: null, format: { country: "KE" } },
  { key: "field_7", label: "Photo of the stall", type: "photo", mandatory: true, help: null, format: { minCount: 1, maxCount: 3 } },
  { key: "field_8", label: "Stall number", type: "text", mandatory: false, help: null, format: { pattern: "code", minLength: 2, maxLength: 6 } },
];

const TODAY = "2026-10-29";
const VALID = {
  values: { field_1: "8925402123456789012", field_2: "3", field_5: "Passport" },
  photoCounts: { field_7: 2 },
};

function validate(values: Record<string, string>, photoCounts: Record<string, number> = VALID.photoCounts) {
  return validateEvidence(FIELDS, { values: { ...VALID.values, ...values }, photoCounts }, { today: TODAY });
}

function issueFor(result: ReturnType<typeof validate>, key: string): string | undefined {
  return result.ok ? undefined : result.issues.find((issue) => issue.key === key)?.message;
}

describe("validation against a configuration (FR-12, issue #48)", () => {
  it("accepts a complete submission and normalises each value by type", () => {
    const result = validate({ field_3: "2.5", field_4: "2026-10-01", field_6: "+254 712 345 678", field_8: "B-12" });
    expect(result).toEqual({
      ok: true,
      values: { field_1: "8925402123456789012", field_2: 3, field_3: 2.5, field_4: "2026-10-01", field_5: "Passport", field_6: "0712345678", field_7: 2, field_8: "B-12" },
    });
  });

  it("rejects a submission that omits mandatory fields, naming each one", () => {
    const result = validateEvidence(FIELDS, { values: { field_2: "3" }, photoCounts: {} }, { today: TODAY });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(["SIM serial number", "ID document seen", "Photo of the stall"]);
    expect(result.issues.map((issue) => issue.key)).toEqual(["field_1", "field_5", "field_7"]);
  });

  it("treats a value of only spaces as missing, and an empty optional field as absent", () => {
    const result = validate({ field_1: "   " });
    expect(result.ok ? [] : result.missing).toEqual(["SIM serial number"]);
    const ok = validate({ field_3: "" });
    expect(ok.ok && "field_3" in ok.values).toBe(false);
  });

  it("checks text length and allowed characters", () => {
    expect(issueFor(validate({ field_1: "89254021234" }), "field_1")).toBe("Enter at least 19 characters.");
    expect(issueFor(validate({ field_1: "892540212345678901234" }), "field_1")).toBe("Enter at most 20 characters.");
    expect(issueFor(validate({ field_1: "8925402123456789O12" }), "field_1")).toBe("Digits only.");
    expect(issueFor(validate({ field_8: "B 12" }), "field_8")).toBe("Letters, digits and hyphens.");
    expect(issueFor(validate({ field_8: "B-1\u0007" }), "field_8")).toBe("Remove the control characters.");
  });

  it("checks numbers: whole or decimal places, and bounds", () => {
    expect(issueFor(validate({ field_2: "2.5" }), "field_2")).toBe("Enter a whole number.");
    expect(issueFor(validate({ field_2: "11" }), "field_2")).toBe("Enter 10 or less.");
    expect(issueFor(validate({ field_2: "0" }), "field_2")).toBe("Enter 1 or more.");
    expect(issueFor(validate({ field_2: "three" }), "field_2")).toBe("Enter a whole number.");
    expect(issueFor(validate({ field_3: "2.55" }), "field_3")).toBe("Enter a number with at most 1 decimal place.");
    expect(issueFor(validate({ field_3: "-1" }), "field_3")).toBe("Enter 0 or more.");
    expect(issueFor(validate({ field_3: "1e3" }), "field_3")).toBe("Enter a number with at most 1 decimal place.");
  });

  it("checks dates: real calendar dates in YYYY-MM-DD, not in the future when so configured", () => {
    expect(issueFor(validate({ field_4: "2026-02-30" }), "field_4")).toBe("Enter a real date as YYYY-MM-DD.");
    expect(issueFor(validate({ field_4: "29/10/2026" }), "field_4")).toBe("Enter a real date as YYYY-MM-DD.");
    expect(issueFor(validate({ field_4: "2026-10-30" }), "field_4")).toBe("The date cannot be in the future.");
    expect(validate({ field_4: TODAY }).ok).toBe(true);
  });

  it("checks a choice is one of the client's options, exactly", () => {
    expect(issueFor(validate({ field_5: "Driving licence" }), "field_5")).toBe("Choose one of the listed options.");
    expect(issueFor(validate({ field_5: "passport" }), "field_5")).toBe("Choose one of the listed options.");
  });

  it("checks phone numbers are Kenyan mobiles", () => {
    expect(issueFor(validate({ field_6: "0201234567" }), "field_6")).toBe("Enter a Kenyan mobile number, e.g. 0712 345 678.");
    expect(issueFor(validate({ field_6: "071234567" }), "field_6")).toBe("Enter a Kenyan mobile number, e.g. 0712 345 678.");
    expect(validate({ field_6: "0112-345-678" }).ok).toBe(true);
  });

  it("checks how many photos each photo field has", () => {
    expect(issueFor(validate({}, { field_7: 4 }), "field_7")).toBe("Attach at most 3 photos.");
    expect(validate({}, { field_7: 0 })).toMatchObject({ ok: false, missing: ["Photo of the stall"] });
  });

  it("reports every failure at once, each against its own field", () => {
    const result = validate({ field_1: "123", field_2: "99", field_5: "Visa", field_6: "123" });
    expect(result.ok ? [] : result.issues.map((issue) => issue.key)).toEqual(["field_1", "field_2", "field_5", "field_6"]);
  });

  it("reads only the configured fields: a value under any other key is ignored", () => {
    const result = validate({ field_99: "smuggled", injected: "x" });
    expect(result.ok && Object.keys(result.values)).toEqual(["field_1", "field_2", "field_5", "field_7"]);
  });
});

describe("configuration rules (FR-05, issue #46)", () => {
  const field = (overrides: Partial<FieldInput> & Pick<FieldInput, "type" | "format">): FieldInput =>
    ({ label: "A field", mandatory: true, help: null, ...overrides }) as FieldInput;

  it("accepts every type with a sensible format", () => {
    expect(evidenceConfigInputSchema.safeParse(FIELDS.map(({ key: _k, ...rest }) => rest)).success).toBe(true);
  });

  it("refuses contradictory or unusable formats", () => {
    const bad: FieldInput[][] = [
      [field({ type: "text", format: { pattern: "any", minLength: 10, maxLength: 5 } })],
      [field({ type: "number", format: { decimals: 0, min: 10, max: 1 } })],
      [field({ type: "number", format: { decimals: 5, min: null, max: null } })],
      [field({ type: "single_select", format: { options: [{ value: "Only", label: "Only" }] } })],
      [field({ type: "single_select", format: { options: [{ value: "A", label: "A" }, { value: "a", label: "a" }] } })],
      [field({ type: "photo", format: { minCount: 0, maxCount: 2 } })],
      [field({ type: "photo", mandatory: false, format: { minCount: 1, maxCount: 2 } })],
      [field({ type: "photo", format: { minCount: 1, maxCount: 8 } }), field({ label: "Second", type: "photo", format: { minCount: 1, maxCount: 5 } })],
      [field({ type: "date", format: { allowFuture: false } }), field({ label: "a FIELD", type: "date", format: { allowFuture: false } })],
      [field({ label: "x", type: "date", format: { allowFuture: false } })],
      Array.from({ length: 21 }, (_, i) => field({ label: `Field ${i}`, type: "date", format: { allowFuture: true } })),
    ];
    for (const config of bad) expect(evidenceConfigInputSchema.safeParse(config).success, JSON.stringify(config).slice(0, 120)).toBe(false);
  });

  it("refuses a field type that does not exist, such as money", () => {
    expect(evidenceConfigInputSchema.safeParse([{ label: "Amount paid", type: "currency", mandatory: true, help: null, format: {} }]).success).toBe(false);
  });

  it("keeps a field's key across versions and gives new fields fresh keys", () => {
    const v1 = withKeys(evidenceConfigInputSchema.parse([field({ type: "date", format: { allowFuture: false } }), field({ label: "Second field", type: "phone", format: { country: "KE" } })]));
    expect(v1.map((f) => f.key)).toEqual(["field_1", "field_2"]);
    // Version 2 drops field_1, keeps field_2 and adds one: the new field does not reuse field_1.
    const v2 = withKeys(evidenceConfigInputSchema.parse([{ ...v1[1] }, field({ label: "Third field", type: "date", format: { allowFuture: true } })]), v1);
    expect(v2.map((f) => f.key)).toEqual(["field_2", "field_3"]);
  });

  it("describes each expected format in words", () => {
    expect(FIELDS.map(describeFormat)).toEqual([
      "Digits only, 19 to 20 characters",
      "Whole number from 1 to 10",
      "Number with up to 1 decimal place, 0 or more",
      "Date (YYYY-MM-DD), not in the future",
      "One of: National ID, Passport",
      "Kenyan mobile number, e.g. 0712 345 678",
      "1 to 3 photos",
      "Letters, digits and hyphens, 2 to 6 characters",
    ]);
    expect(displayValue(FIELDS[5], "0712345678")).toBe("0712 345 678");
  });
});
