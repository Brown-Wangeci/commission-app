/**
 * A place a person has to choose: an agent's base and the centre of a job
 * area. A blank value used to be coerced to 0, so a form or an API call that
 * never chose a place stored latitude 0, longitude 0 (defect 19). The server
 * schemas and both browser forms share these rules.
 */
export const HOME_LOCATION_REQUIRED = "Choose where you are based: search for the place or use your location.";
export const JOB_LOCATION_REQUIRED = "Choose the centre of the job area: search for the place, use your location or click the map.";

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

/** Coordinates as the forms send them: six decimals is about 0.1 m, finer than any phone's fix. */
export function coordinate(value: number): string {
  return value.toFixed(6);
}
