import type { ActivationMethod } from "@prisma/client";
import type { FieldDefinition } from "./fields";

/**
 * The platform's own fields, which every submission has whatever the job.
 * They are defined, rendered and validated exactly like a client's fields,
 * so the capture form hardcodes no field, but a client cannot change or
 * remove them: they are the observable inputs the fraud model reads (the
 * customer number, the SIM's registration date, how the details were
 * captured, and whether proof of activation was attached), stored in fixed
 * columns of the activation. The agent's note is stored the same way and
 * read by no model.
 *
 * This is layer two's input surface. A client's fields are layer one: they
 * are stored as JSON in the activation's evidence payload and validated
 * against the job's configuration, and nothing in them is ever sent to the
 * scoring service (issue #49, tests/layer-boundary.test.ts).
 */
export const PLATFORM_FIELDS: FieldDefinition[] = [
  {
    key: "customerMsisdn",
    label: "Customer's phone number",
    type: "phone",
    mandatory: true,
    help: "Stored only as a one-way code; nobody can read the number back.",
    format: { country: "KE" },
  },
  { key: "simRegisteredAt", label: "SIM registration date", type: "date", mandatory: true, help: null, format: { allowFuture: false } },
  {
    key: "activationMethod",
    label: "How did you capture the customer's details?",
    type: "single_select",
    mandatory: true,
    help: null,
    format: {
      options: [
        { value: "qr_scan", label: "Scanned the code on the SIM pack" },
        { value: "manual_entry", label: "Typed them in by hand" },
      ],
    },
  },
  {
    key: "proof",
    label: "Proof of activation",
    type: "photo",
    mandatory: false,
    help: "For example a photo of the activation confirmation message.",
    format: { minCount: 0, maxCount: 1 },
  },
  { key: "agentNote", label: "Note for the reviewer", type: "text", mandatory: false, help: null, format: { pattern: "any", minLength: 0, maxLength: 1000 } },
];

export const PLATFORM_KEYS = new Set(PLATFORM_FIELDS.map((field) => field.key));

/** The platform values, once validated, as the activation's typed columns. */
export type PlatformValues = {
  customerMsisdn: string;
  simRegisteredAt: Date;
  activationMethod: ActivationMethod;
  agentNote: string | null;
};

export function platformValues(values: Record<string, unknown>): PlatformValues {
  return {
    customerMsisdn: String(values.customerMsisdn),
    // A calendar date entered by the agent, read as midnight in Kenya.
    simRegisteredAt: new Date(`${String(values.simRegisteredAt)}T00:00:00+03:00`),
    activationMethod: values.activationMethod as ActivationMethod,
    agentNote: values.agentNote === undefined ? null : String(values.agentNote),
  };
}
