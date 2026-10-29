import { z } from "zod";
import { badRequest } from "@/lib/http/errors";
import { MAX_JOB_PHOTOS } from "@/lib/evidence/fields";
import { idSchema, latitudeSchema, longitudeSchema } from "@/lib/validation";
import type { PhotoInput, SubmissionInput } from "./submit";

/**
 * The multipart form the capture form posts (issue #47). Field names:
 *   evidenceConfigId          the configuration version the form was rendered from
 *   field:<key>               a typed value for one evidence field
 *   photos:<key>              the photo files for one photo field
 *   photoMeta:<key>           JSON: one { capturedAt, gpsLat, gpsLon, gpsAccuracyM, locationSource } per photo
 * plus the device's own context (location, device, network). Nothing here
 * judges the evidence: submitActivation validates every field against the
 * job's configuration, so a crafted request is held to the same rules as
 * the form.
 */

const optionalNumber = z
  .union([z.literal(""), z.null(), z.undefined(), z.coerce.number()])
  .transform((value) => (typeof value === "number" && Number.isFinite(value) ? value : null));

const contextSchema = z.object({
  assignmentId: idSchema,
  evidenceConfigId: idSchema,
  gpsLat: latitudeSchema,
  gpsLon: longitudeSchema,
  gpsAccuracyM: optionalNumber.refine((v) => v === null || v >= 0, "Accuracy cannot be negative."),
  deviceId: z.string().trim().min(4).max(200),
  deviceOs: z.string().trim().min(1).max(40),
  appVersion: z.string().trim().min(1).max(40),
  networkType: z.enum(["cellular", "wifi"]),
  ipRegion: z.string().trim().max(40).optional().transform((v) => (v ? v : null)),
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

/** Photos with their own capture time and place, as the device stamped each one. */
function photosNamed(form: FormData, filesName: string, metaName: string): PhotoInput[] {
  const photos = files(form, filesName);
  let json: unknown = [];
  try {
    const raw = text(form, metaName);
    json = raw ? JSON.parse(raw) : [];
  } catch {
    throw badRequest(`${metaName} must be a JSON array.`);
  }
  const meta = photoMetaSchema.parse(json);
  if (meta.length !== photos.length) throw badRequest(`${metaName} must have one entry per photo.`);
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

function photosFor(form: FormData, key: string): PhotoInput[] {
  return photosNamed(form, `photos:${key}`, `photoMeta:${key}`);
}

/** The photos of an evidence-request reply ("photos" and "photoMeta"), which belong to no field. */
export function photoInputs(form: FormData): PhotoInput[] {
  const photos = photosNamed(form, "photos", "photoMeta");
  if (photos.length > MAX_JOB_PHOTOS) throw badRequest(`Attach at most ${MAX_JOB_PHOTOS} photos.`);
  return photos;
}

/** Turns the submission form into input for submitActivation. Throws 400/422 on a malformed form. */
export function parseSubmissionForm(form: FormData, agentId: string): SubmissionInput {
  const context = contextSchema.parse(Object.fromEntries(Object.keys(contextSchema.shape).map((key) => [key, text(form, key)])));
  const values: Record<string, string> = {};
  const photos: Record<string, PhotoInput[]> = {};
  const keys = new Set<string>();
  for (const name of form.keys()) {
    const match = /^(field|photos|photoMeta):(.{1,64})$/.exec(name);
    if (match) keys.add(`${match[1] === "field" ? "v" : "p"}:${match[2]}`);
  }
  for (const entry of keys) {
    const key = entry.slice(2);
    if (entry.startsWith("v:")) values[key] = text(form, `field:${key}`) ?? "";
    else photos[key] = photosFor(form, key);
  }
  const total = Object.values(photos).reduce((sum, list) => sum + list.length, 0);
  if (total > MAX_JOB_PHOTOS + 1) throw badRequest(`Attach at most ${MAX_JOB_PHOTOS} photos and one proof of activation.`);
  return {
    agentId,
    assignmentId: context.assignmentId,
    evidenceConfigId: context.evidenceConfigId,
    values,
    photos,
    gpsLat: context.gpsLat,
    gpsLon: context.gpsLon,
    gpsAccuracyM: context.gpsAccuracyM,
    device: {
      deviceId: context.deviceId,
      deviceOs: context.deviceOs,
      appVersion: context.appVersion,
      networkType: context.networkType,
      ipRegion: context.ipRegion,
    },
  };
}
