import { formatDistance } from "@/lib/format";
import { kmOutsideArea, type JobArea } from "@/lib/geo";
import { ACTIVATION_LOCATION_REQUIRED, locationMissing } from "@/lib/location";

export type Fix = { lat: number; lon: number; accuracy: number | null };

export type AreaStatusView =
  | { kind: "locating"; text: string }
  | { kind: "unknown"; text: string }
  | { kind: "inside"; text: string }
  | { kind: "outside"; text: string };

/**
 * Where the agent's location fix is against the job area, in words. It uses
 * kmOutsideArea, the function the review screen uses for "outside the job
 * area", so the agent sees the same answer the reviewer will.
 */
export function areaStatus(area: JobArea, fix: Fix | null, locating: boolean): AreaStatusView {
  if (!fix) return locating ? { kind: "locating", text: "Finding your location" } : { kind: "unknown", text: "Your location was not found" };
  const outside = kmOutsideArea(area, fix.lat, fix.lon);
  if (outside > 0) return { kind: "outside", text: `${formatDistance(outside)} outside the job area` };
  const accuracy = fix.accuracy === null ? "" : ` (location accurate to about ${Math.round(fix.accuracy)} m)`;
  return { kind: "inside", text: `Inside the job area${accuracy}` };
}

type Props = { area: JobArea & { areaName: string }; fix: Fix | null; locating: boolean; onRetry: () => void };

/** One line at the top of the activation form: inside the job area, how far outside, or not found. */
export function AreaStatus({ area, fix, locating, onRetry }: Props) {
  const status = areaStatus(area, fix, locating);
  return (
    <section className={`area-status ${status.kind}`} aria-labelledby="area-status-text">
      <div className="grow">
        <p id="area-status-text" className="area-status-text" role="status">{status.text}</p>
        <p className="hint">Job area: {area.areaName}, within {formatDistance(area.areaRadiusM / 1000)}.{status.kind === "outside" ? " You can still submit; the reviewer sees the distance." : ""}{status.kind === "unknown" ? " Turn on location and try again." : ""}</p>
      </div>
      {status.kind !== "locating" && (
        <button type="button" className="btn small" onClick={onRetry}>{status.kind === "unknown" ? "Try again" : "Update my location"}</button>
      )}
    </section>
  );
}

/**
 * Why the form cannot be sent for want of a location, or null when it can: the
 * coordinates are blank, not numbers or exactly 0, 0 (defect 20).
 */
export function locationBlock(lat: string, lon: string, locating: boolean): string | null {
  if (!locationMissing(lat, lon)) return null;
  return locating ? "Still finding your location. Wait a moment, then submit again." : ACTIVATION_LOCATION_REQUIRED;
}

/** Shown beside the Submit button when it was pressed without a location: what to do, and Try again. */
export function LocationNeeded({ message, locating, onRetry }: { message: string; locating: boolean; onRetry: () => void }) {
  return (
    <div className="alert error location-needed" role="alert">
      <span className="grow">{message}</span>
      <button type="button" className="btn small" onClick={onRetry} disabled={locating}>Try again</button>
    </div>
  );
}
