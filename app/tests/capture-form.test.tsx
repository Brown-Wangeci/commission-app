import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EvidenceFieldInputs } from "@/components/agent/EvidenceFieldInputs";
import type { FieldDefinition } from "@/lib/evidence/fields";
import { PLATFORM_FIELDS } from "@/lib/evidence/platform";

/**
 * FR-09, issue #47: the capture form is rendered from the field
 * configuration. Two jobs with different configurations give two different
 * forms, and the form's source names no evidence field of its own.
 */
const SIM_JOB: FieldDefinition[] = [
  { key: "field_1", label: "Photo of the SIM pack", type: "photo", mandatory: true, help: "Hold it flat.", format: { minCount: 1, maxCount: 8 } },
  { key: "field_2", label: "SIM serial number (ICCID)", type: "text", mandatory: true, help: null, format: { pattern: "digits", minLength: 19, maxLength: 20 } },
  { key: "field_3", label: "Customer type", type: "single_select", mandatory: true, help: null, format: { options: [{ value: "New", label: "New to the network" }, { value: "Switching", label: "Switching networks" }] } },
];
const BUNDLE_JOB: FieldDefinition[] = [
  { key: "field_1", label: "Bundle sold", type: "single_select", mandatory: true, help: null, format: { options: ["Daily", "Weekly", "Monthly", "Unlimited", "Night"].map((v) => ({ value: v, label: v })) } },
  { key: "field_2", label: "Bundles activated", type: "number", mandatory: true, help: null, format: { decimals: 0, min: 1, max: 10 } },
  { key: "field_3", label: "Last bundle date", type: "date", mandatory: false, help: null, format: { allowFuture: false } },
  { key: "field_4", label: "Stall owner's number", type: "phone", mandatory: false, help: null, format: { country: "KE" } },
];

function render(fields: FieldDefinition[]): string {
  return renderToStaticMarkup(<EvidenceFieldInputs fields={fields} errors={{ field_2: "Enter at least 19 characters." }} photos={{ field_1: [{ name: "pack.jpg", located: true }] }} locationKnown today="2026-10-29" />);
}

describe("the capture form is built from the configuration (FR-09, issue #47)", () => {
  it("renders each configured field, in order, with its label, input, format and mandatory flag", () => {
    const html = render(SIM_JOB);
    const order = SIM_JOB.map((field) => html.indexOf(`data-field-key="${field.key}"`));
    expect(order.every((position, i) => position > (order[i - 1] ?? -1))).toBe(true);
    expect(html).toContain("Photo of the SIM pack");
    expect(html).toMatch(/type="file"[^>]*multiple/);
    expect(html).toContain("1 of 8 attached");
    expect(html).toContain('name="field:field_2"');
    expect(html).toContain('maxLength="20"');
    expect(html).toContain("Digits only, 19 to 20 characters");
    expect(html).toContain('type="radio" name="field:field_3" value="New"');
    expect(html).toContain("Enter at least 19 characters.");
    expect(html).not.toContain("(optional)");
  });

  it("renders a different job's configuration as a different form", () => {
    const sim = render(SIM_JOB);
    const bundle = render(BUNDLE_JOB);
    expect(bundle).toContain('<select id="f-field_1" name="field:field_1"');
    expect(bundle).toContain('inputMode="numeric"');
    expect(bundle).toContain('type="date"');
    expect(bundle).toContain('max="2026-10-29"');
    expect(bundle).toContain('inputMode="tel"');
    expect(bundle.match(/\(optional\)/g)).toHaveLength(2);
    for (const label of ["Photo of the SIM pack", "SIM serial number", "Customer type"]) expect(bundle).not.toContain(label);
    for (const label of ["Bundle sold", "Bundles activated", "Last bundle date"]) expect(sim).not.toContain(label);
  });

  it("renders the platform's own fields from their definitions too", () => {
    const html = render(PLATFORM_FIELDS);
    for (const field of PLATFORM_FIELDS) expect(html).toContain(`data-field-key="${field.key}"`);
    expect(html).toContain("Customer&#x27;s phone number");
    expect(html).toContain('value="manual_entry"');
  });

  it("hardcodes no evidence field in the form's source", () => {
    const source = ["src/components/agent/SubmitActivationForm.tsx", "src/components/agent/EvidenceFieldInputs.tsx"]
      .map((file) => fs.readFileSync(path.resolve(__dirname, "..", file), "utf8"))
      .join("\n");
    for (const name of [...PLATFORM_FIELDS.map((f) => f.key), ...PLATFORM_FIELDS.map((f) => f.label), "Proof of activation", "photos\""]) {
      expect(source, name).not.toContain(name);
    }
  });
});
