import { outsideKenya, typedLocationProblem, validPoint } from "@/lib/location";

export const OUTSIDE_KENYA_WARNING = "This point is outside Kenya. Check the latitude and longitude; you can still continue.";

/**
 * The secondary way to give a location, under Advanced on sign-up and Post a
 * job: it makes the coordinate fields editable. Off by default, and labelled
 * for rare cases. The activation form has no such option: its location is
 * evidence captured by the device (FR-10).
 */
export function ManualToggle({ checked, onChange, without }: { checked: boolean; onChange: (on: boolean) => void; without: string }) {
  return (
    <div className="manual-entry">
      <label className="manual-toggle">
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        Enter coordinates yourself
      </label>
      <span className="hint">For rare cases only, when {without} cannot give the right point.</span>
    </div>
  );
}

/** About coordinates being typed: what is wrong with them, or that they are outside Kenya, which is allowed. */
export function TypedNotes({ lat, lon }: { lat: string; lon: string }) {
  const problem = typedLocationProblem(lat, lon);
  if (problem) return <span className="field-error" role="status">{problem}</span>;
  const point = validPoint(lat, lon);
  return point && outsideKenya(point) ? <div className="alert warn" role="status">{OUTSIDE_KENYA_WARNING}</div> : null;
}
