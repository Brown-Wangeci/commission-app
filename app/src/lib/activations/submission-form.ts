import { z } from "zod";
import { badRequest } from "@/lib/http/errors";
import { idSchema, kenyanMsisdnSchema, latitudeSchema, longitudeSchema } from "@/lib/validation";
import { MAX_PHOTOS, type PhotoInput, type SubmissionInput } from "./submit";

/** A calendar date entered by the agent, read as midnight Nairobi time. */
const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date format YYYY-MM-DD.")
  .transform((value) => new Date(`${value}T00:00:00+03:00`))
  .refine((date) => !Number.isNaN(date.getTime()), "Enter a real date.");

const optionalNumber = z
  .union([z.literal(""), z.null(), z.undefined(), z.coerce.number()])
  .transform((value) => (typeof value === "number" && Number.isFinite(value) ? value : null));

const fieldsSchema = z.object({
  assignmentId: idSchema,
  customerMsisdn: kenyanMsisdnSchema,
  simRegisteredAt: localDateSchema,
  activationMethod: z.enum(["qr_scan", "manual_entry"]),
  gpsLat: latitudeSchema,
  gpsLon: longitudeSchema,
  gpsAccuracyM: optionalNumber.refine((v) => v === null || v >= 0, "Accuracy cannot be negative."),
  deviceId: z.string().trim().min(4).max(200),
  deviceOs: z.string().trim().min(1).max(40),
  appVersion: z.string().trim().min(1).max(40),
  networkType: z.enum(["cellular", "wifi"]),
  ipRegion: z.string().trim().max(40).optional().transform((v) => (v ? v : null)),
  agentNote: z.string().trim().max(1000).optional().transform((v) => (v ? v : null)),
});

const photoMetaSchema = z.array(
  z.object({
    capturedAt: z.string().datetime({ offset: true }).nullable().optional(),
    gpsLat: z.number().min(-90).max(90).nullable().optional(),
    gpsLon: z.number().min(-180).max(180).nullable().optional(),
    gpsAccuracyM: z.number().min(0).nullable().optional(),
    locationSource: z.enum(["exif", "device", "none"]),
  }),
);

function text(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" ? value : undefined;
}

function files(form: FormData, name: string): File[] {
  return form.getAll(name).filter((value): value is File => value instanceof File && value.size > 0);
}

function parsePhotoMeta(raw: string | undefined, count: number) {
  let json: unknown = [];
  try {
    json = raw ? JSON.parse(raw) : [];
  } catch {
    throw badRequest("photoMeta must be a JSON array.");
  }
  const meta = photoMetaSchema.parse(json);
  if (meta.length !== count) throw badRequest("photoMeta must have one entry per photo.");
  return meta;
}

function photoInputs(form: FormData): PhotoInput[] {
  const photos = files(form, "photos");
  if (photos.length > MAX_PHOTOS) throw badRequest(`Attach at most ${MAX_PHOTOS} photos.`);
  const meta = parsePhotoMeta(text(form, "photoMeta"), photos.length);
  return photos.map((file, index) => {
    const m = meta[index];
    const hasGps = m.gpsLat != null && m.gpsLon != null;
    return {
      file,
      capturedAt: m.capturedAt ? new Date(m.capturedAt) : null,
      gpsLat: hasGps ? m.gpsLat! : null,
      gpsLon: hasGps ? m.gpsLon! : null,
      gpsAccuracyM: hasGps ? m.gpsAccuracyM ?? null : null,
      locationSource: hasGps ? m.locationSource : "none",
    };
  });
}

/** Turns the submission form into validated input. Throws 400/422 on bad input. */
export function parseSubmissionForm(form: FormData, agentId: string): SubmissionInput {
  const fields = fieldsSchema.parse(Object.fromEntries(
    Object.keys(fieldsSchema.shape).map((key) => [key, text(form, key)]),
  ));
  const proof = files(form, "proof")[0] ?? null;
  return {
    agentId,
    assignmentId: fields.assignmentId,
    customerMsisdn: fields.customerMsisdn,
    simRegisteredAt: fields.simRegisteredAt,
    activationMethod: fields.activationMethod,
    gpsLat: fields.gpsLat,
    gpsLon: fields.gpsLon,
    gpsAccuracyM: fields.gpsAccuracyM,
    device: {
      deviceId: fields.deviceId,
      deviceOs: fields.deviceOs,
      appVersion: fields.appVersion,
      networkType: fields.networkType,
      ipRegion: fields.ipRegion,
    },
    agentNote: fields.agentNote,
    photos: photoInputs(form),
    proof,
  };
}
