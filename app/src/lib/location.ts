/**
 * Rules for a location: the place a person chooses (an agent's base, the
 * centre of a job area) and the one a device reports with an activation. A
 * blank value used to be coerced to 0, so a form or an API call with no place
 * stored latitude 0, longitude 0 (defects 19 and 20). The server schemas and
 * the browser forms share these rules.
 */
export const HOME_LOCATION_REQUIRED = "Choose where you are based: search for the place or use your location.";
export const JOB_LOCATION_REQUIRED = "Choose the centre of the job area: search for the place, use your location or click the map.";
/** An activation's location comes from the device, so the way to fix it is to turn location on. */
export const ACTIVATION_LOCATION_REQUIRED = "Your location is needed to submit. Turn on location and try again.";
/** A photo may have no location, but not a false one. */
export const PHOTO_LOCATION_INVALID = "A photo cannot be located at latitude 0, longitude 0. Remove it, turn on location and add it again.";
export const OUT_OF_RANGE = "Latitude must be from -90 to 90 and longitude from -180 to 180.";

/**
 * A rectangle around Kenya, used only to warn about typed coordinates, never to
 * refuse them. Source: the bounding box of "Kenya National Boundaries"
 * (Harvard Map Collection, 2002), read 25 November 2026 from
 * geodata.libraries.mit.edu/record/gisogm:edu.harvard:bf20fa4c816f, printed as
 * (33.908859, 41.911373, 5.428018, -4.680452) and read as west, east, north,
 * south. A rectangle also takes in parts of neighbouring countries, which
 * therefore raise no warning.
 */
export const KENYA_BOUNDS = { west: 33.908859, east: 41.911373, north: 5.428018, south: -4.680452 } as const;

export type Point = { lat: number; lon: number };

/** The number a coordinate stands for, or undefined for anything that is not one (blank, null, text). */
export function coordinateValue(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/**
 * True when no real place was given: either value is missing or is not a
 * number, or both are exactly 0. One zero alone is a real place (the equator
 * crosses Kenya).
 */
export function locationMissing(lat: unknown, lon: unknown): boolean {
  const a = coordinateValue(lat);
  const b = coordinateValue(lon);
  return a === undefined || b === undefined || (a === 0 && b === 0);
}

/** Why a location cannot be used, or null: `required` when there is none, the range message when it is off the globe. */
export function locationProblem(lat: unknown, lon: unknown, required: string): string | null {
  if (locationMissing(lat, lon)) return required;
  return Math.abs(Number(lat)) > 90 || Math.abs(Number(lon)) > 180 ? OUT_OF_RANGE : null;
}

/** The point two values stand for, when it passes the rules the server applies. */
export function validPoint(lat: unknown, lon: unknown): Point | null {
  return locationProblem(lat, lon, "missing") === null ? { lat: Number(lat), lon: Number(lon) } : null;
}

/** What is wrong with coordinates someone is typing, in words; null when they are usable or nothing is typed yet. */
export function typedLocationProblem(lat: string, lon: string): string | null {
  const blank = [lat, lon].map((value) => value.trim() === "");
  if (blank[0] && blank[1]) return null;
  if ([lat, lon].some((value, i) => !blank[i] && coordinateValue(value) === undefined)) {
    return "Enter numbers only, with a dot for decimals, for example -1.2921 and 36.8219.";
  }
  if (blank[0] || blank[1]) return "Enter both latitude and longitude.";
  return locationProblem(lat, lon, "Latitude 0, longitude 0 is not a real place.");
}

export function outsideKenya({ lat, lon }: Point): boolean {
  return lat < KENYA_BOUNDS.south || lat > KENYA_BOUNDS.north || lon < KENYA_BOUNDS.west || lon > KENYA_BOUNDS.east;
}

/** A longitude brought back onto the globe, for a click on a repeated copy of the world map. */
export function wrapLongitude(lon: number): number {
  return Math.abs(lon) <= 180 ? lon : ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Coordinates as the forms send them: six decimals is about 0.1 m, finer than any phone's fix. */
export function coordinate(value: number): string {
  return value.toFixed(6);
}
