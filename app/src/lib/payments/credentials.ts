import { z } from "zod";

/**
 * M-Pesa credentials, read from the environment only and never from a file in
 * the repository. Kept apart from `config()` so the app runs without them: the
 * payment routes refuse and the worker waits until they are set.
 *
 * Nothing here may reach a log or an error message. `missingCredentials`
 * returns variable names, never values.
 */
const schema = z.object({
  MPESA_CONSUMER_KEY: z.string().min(1),
  MPESA_CONSUMER_SECRET: z.string().min(1),
  /** The Paybill or Till that receives STK Push payments. */
  MPESA_STK_SHORTCODE: z.string().regex(/^\d{5,9}$/),
  MPESA_STK_PASSKEY: z.string().min(1),
  /** The shortcode B2C payments are sent from. */
  MPESA_B2C_SHORTCODE: z.string().regex(/^\d{5,9}$/),
  MPESA_B2C_INITIATOR_NAME: z.string().min(1),
  /** The initiator password, already encrypted by the portal's test credentials page. */
  MPESA_B2C_SECURITY_CREDENTIAL: z.string().min(1),
  /**
   * Public HTTPS origin Daraja can reach. Every callback URL is built from
   * this at the moment of sending; no host is fixed anywhere else, because a
   * development tunnel gets a new host on every restart.
   */
  MPESA_CALLBACK_BASE_URL: z
    .string()
    .regex(/^https:\/\/[^/\s]+\/?$/)
    .transform((url) => url.replace(/\/$/, "")),
});

export type MpesaCredentials = z.infer<typeof schema>;

/** The credentials, or null if any is missing or malformed. */
export function mpesaCredentials(): MpesaCredentials | null {
  const parsed = schema.safeParse(process.env);
  return parsed.success ? parsed.data : null;
}

/** Names of the variables that are missing or malformed. Values are never included. */
export function missingCredentials(): string[] {
  const parsed = schema.safeParse(process.env);
  if (parsed.success) return [];
  return [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
}

/**
 * Every value that must never appear in text. Read straight from the
 * environment, not from `mpesaCredentials()`, so scrubbing still works while
 * the configuration is incomplete, for example before the callback URL is set.
 */
export function secretValues(): string[] {
  const names = ["MPESA_CONSUMER_KEY", "MPESA_CONSUMER_SECRET", "MPESA_STK_PASSKEY", "MPESA_B2C_SECURITY_CREDENTIAL", "MPESA_B2C_INITIATOR_NAME"];
  return names.flatMap((name) => (process.env[name] ? [process.env[name] as string] : []));
}
