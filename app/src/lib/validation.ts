import { z } from "zod";
import { MAX_ROW_CENTS } from "@/lib/money/cents";
import { BPS_PER_WHOLE } from "@/lib/money/commission";

/** Shared input rules, so every route validates the same field the same way. */

/**
 * Money in a request: a JSON integer number of cents. Text such as "1500" is
 * refused rather than coerced, because it would be ambiguous whether it meant
 * shillings or cents.
 */
export function centsSchema(label: string, min = 0) {
  const whole = `${label} must be a whole number of cents.`;
  return z
    .number({ invalid_type_error: whole, required_error: `${label} is required.` })
    .int(whole)
    .min(min, min > 0 ? `${label} must be at least 1 cent.` : `${label} cannot be negative.`)
    .max(MAX_ROW_CENTS, `${label} is larger than one record can hold.`);
}

/** A rate in basis points: 1 (0.01%) to 10000 (100%). */
export const rateBpsSchema = z
  .number({ invalid_type_error: "The rate must be a whole number of basis points.", required_error: "The rate is required." })
  .int("The rate must be a whole number of basis points.")
  .min(1, "The rate must be at least 1 basis point (0.01%).")
  .max(BPS_PER_WHOLE, "The rate cannot exceed 10000 basis points (100%).");

export const idSchema = z.string().trim().min(1).max(64);

export const nameSchema = z.string().trim().min(2, "Enter at least 2 characters.").max(120);

export const emailSchema = z.string().trim().toLowerCase().email("Enter a valid email address.").max(200);

export const passwordSchema = z
  .string()
  .min(8, "Use at least 8 characters.")
  .max(200, "Use at most 200 characters.");

/** Kenyan mobile numbers: 07XXXXXXXX, 01XXXXXXXX, or the same with +254 / 254. */
export const kenyanMsisdnSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s-]/g, ""))
  .refine((value) => /^(?:\+?254|0)(?:7|1)\d{8}$/.test(value), "Enter a Kenyan mobile number, e.g. 0712 345 678.")
  .transform(normaliseMsisdn);

/** Converts any accepted form to the local 0XXXXXXXXX form. */
export function normaliseMsisdn(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.startsWith("254")) return `0${digits.slice(3)}`;
  return digits;
}

export const latitudeSchema = z.coerce.number().min(-90).max(90);
export const longitudeSchema = z.coerce.number().min(-180).max(180);

export const reasonTextSchema = z
  .string()
  .trim()
  .min(5, "Give a reason of at least 5 characters.")
  .max(2000, "Keep the reason under 2000 characters.");
