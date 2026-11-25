"use client";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { FieldErrors } from "@/lib/client-api";
import { JOB_LOCATION_REQUIRED, OUT_OF_RANGE, coordinate, typedLocationProblem, validPoint, wrapLongitude } from "@/lib/location";
import { GEOCODER_URL, PLACE_ZOOM } from "@/lib/map/config";
import { createGeocoder, type Place } from "@/lib/map/geocode";
import { RADIUS_PROBLEM, RADIUS_STEPS_M, circleBounds, exactRadiusLabel, radiusLabel, radiusStepIndex, validRadius } from "@/lib/map/radius";
import { LeafletMap, type MapApi, type Move, type Point, type View } from "@/components/map/LeafletMap";
import { ManualToggle, TypedNotes } from "@/components/ManualCoordinates";

export { coordinate };

function FieldError({ errors, name }: { errors: FieldErrors; name: string }) {
  return errors[name] ? <span className="field-error">{errors[name]}</span> : null;
}

type Props = { errors: FieldErrors; defaultRadiusM: number };

/**
 * The job area: a place name, a pin and a radius. The pin is placed by a
 * place search, the device's location, a click on the map or dragging the
 * pin, and the radius by a slider with the circle drawn live. Whatever moved
 * them, the same three form fields are filled (areaLat, areaLon,
 * areaRadiusM, shown under Advanced), so the form sends exactly what it sent
 * when they were typed by hand. They are read-only there unless the client
 * chooses to enter coordinates themselves, a secondary option for rare cases;
 * the pin and circle are drawn from the same values, so they stay in step.
 */
export function JobAreaPicker({ errors, defaultRadiusM }: Props) {
  // The three form fields are the one source; the pin, the circle and the slider are read from them.
  const [text, setText] = useState({ lat: "", lon: "" });
  const [radiusText, setRadiusText] = useState(String(defaultRadiusM));
  const [typed, setTyped] = useState(false);
  const [manual, setManual] = useState(false);
  const [areaName, setAreaName] = useState("");
  const [autoName, setAutoName] = useState<string | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Place[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const api = useRef<MapApi | null>(null);
  const search = useMemo(() => (GEOCODER_URL ? createGeocoder(GEOCODER_URL) : null), []);
  const pin = validPoint(text.lat, text.lon);
  const radius = validRadius(radiusText);
  const step = radiusStepIndex(radius ?? defaultRadiusM);
  const radiusShown = radius === null ? "not set" : exactRadiusLabel(radius);

  const moves = useRef(0);
  const moveTo = (next: Move) => setView({ ...next, key: (moves.current += 1) });

  /** A point from the map, a search or the device. */
  function place(point: Point) {
    setText({ lat: coordinate(point.lat), lon: coordinate(wrapLongitude(point.lon)) });
    setTyped(false);
  }

  function typeCoordinate(patch: Partial<typeof text>) {
    setText((current) => ({ ...current, ...patch }));
    setTyped(true);
  }

  /** Once a typed value is left, the map moves to show the typed circle. */
  function showTyped() {
    if (manual && pin && radius !== null) moveTo({ bounds: circleBounds(pin, radius) });
  }

  /** Switching typing off keeps usable values and drops unusable ones, so a read-only field never holds a bad value. */
  function toggleManual(on: boolean) {
    setManual(on);
    if (on) return;
    if (!pin) {
      setText({ lat: "", lon: "" });
      setTyped(false);
    }
    if (radius === null) setRadiusText(String(RADIUS_STEPS_M[step]));
  }

  async function runSearch() {
    if (!search || query.trim() === "") return;
    setSearching(true);
    setNote(null);
    try {
      const places = await search(query);
      setResults(places);
      if (places.length === 0) setNote("No place found in Kenya with that name. Try a nearby landmark or town, or click the map.");
    } catch {
      setResults(null);
      setNote("Place search is not available right now. Click the map or use your location instead.");
    }
    setSearching(false);
  }

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    // Enter searches; it must not submit the job form around this field.
    if (event.key !== "Enter") return;
    event.preventDefault();
    void runSearch();
  }

  function choose(found: Place) {
    place(found);
    moveTo(found.bounds ? { bounds: found.bounds } : { lat: found.lat, lon: found.lon, zoom: PLACE_ZOOM });
    const short = found.name.split(",")[0].trim();
    if (areaName.trim() === "" || areaName === autoName) {
      setAreaName(short);
      setAutoName(short);
    }
    setResults(null);
  }

  function useMyLocation() {
    if (!navigator.geolocation) return setNote("Location is not available in this browser. Search for the place or click the map.");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const here = { lat: position.coords.latitude, lon: position.coords.longitude };
        place(here);
        moveTo({ ...here, zoom: PLACE_ZOOM });
        setNote(null);
      },
      () => setNote("Location is not available in this browser. Search for the place or click the map."),
    );
  }

  function pinAtCentre() {
    const centre = api.current?.centre();
    if (centre) place(centre);
  }

  // A message about the area goes once the values are usable; while typing, the note about the typed values stands in for it.
  const reported = errors.areaLat || errors.areaLon;
  const answered = (reported === JOB_LOCATION_REQUIRED || reported === OUT_OF_RANGE) && pin !== null;
  const typedProblem = typed && typedLocationProblem(text.lat, text.lon) !== null;
  const locationError = answered || typedProblem ? undefined : reported;
  const radiusProblem = manual && radius === null;
  const radiusError = radiusProblem || (errors.areaRadiusM === RADIUS_PROBLEM && radius !== null) ? undefined : errors.areaRadiusM;
  return (
    <div className="stack">
      <div className="field">
        <label htmlFor="areaName">Place name</label>
        <input id="areaName" name="areaName" className="input" value={areaName} onChange={(e) => setAreaName(e.target.value)} />
        <span className="hint">Filled in from a place you search for; change it to what agents call the place.</span>
        <FieldError errors={errors} name="areaName" />
      </div>

      {search && (
        <div className="field">
          <label htmlFor="placeSearch">Find the place on the map</label>
          <div className="map-search">
            <input id="placeSearch" type="search" className="input" value={query} placeholder="e.g. Gikomba Market, Nairobi" onChange={(e) => setQuery(e.target.value)} onKeyDown={onSearchKey} />
            <button type="button" className="btn" onClick={() => void runSearch()} disabled={searching || query.trim() === ""}>{searching ? "Searching" : "Search"}</button>
          </div>
          {results && results.length > 0 && (
            <ul className="map-results" aria-label="Places found">
              {results.map((place) => (
                <li key={`${place.lat},${place.lon}`}><button type="button" className="map-result" onClick={() => choose(place)}>{place.name}</button></li>
              ))}
            </ul>
          )}
        </div>
      )}
      {note && <p className="small muted" role="status">{note}</p>}

      <div className="map-frame">
        <LeafletMap pin={pin} radiusM={radius ?? 0} onPick={place} view={view} apiRef={api} label="Map of the job area. Click to place the centre, or drag the pin." />
      </div>
      <div className="row wrap">
        <button type="button" className="btn small" onClick={useMyLocation}>Use my location</button>
        <button type="button" className="btn small" onClick={pinAtCentre}>Put the pin at the map centre</button>
      </div>
      <p className="hint">
        {pin ? "Drag the pin or click the map to move the centre." : "Search for the place, use your location, or click the map to place the pin."} Photos taken outside the circle are flagged to the reviewer.
      </p>
      {locationError && <span className="field-error" role="alert">{locationError}</span>}
      {typed && <TypedNotes lat={text.lat} lon={text.lon} />}

      <div className="field">
        <label htmlFor="areaRadiusRange">Radius: <span className="strong num">{radiusShown}</span></label>
        <input
          id="areaRadiusRange"
          type="range"
          className="range"
          min={0}
          max={RADIUS_STEPS_M.length - 1}
          step={1}
          value={step}
          aria-valuetext={radiusShown}
          onChange={(e) => setRadiusText(String(RADIUS_STEPS_M[Number(e.target.value)]))}
        />
        <span className="hint">From {radiusLabel(RADIUS_STEPS_M[0])} to {radiusLabel(RADIUS_STEPS_M[RADIUS_STEPS_M.length - 1])}.</span>
        {radiusProblem && <span className="field-error" role="status">{RADIUS_PROBLEM}</span>}
        {radiusError && <span className="field-error">{radiusError}</span>}
      </div>

      <details className="help-more">
        <summary className="small">Advanced: the values sent</summary>
        <ManualToggle checked={manual} onChange={toggleManual} without="search, your location and the map" />
        <div className="grid-3" style={{ marginTop: 8 }}>
          <div className="field"><label htmlFor="areaLat">Centre latitude</label><input id="areaLat" name="areaLat" className="input" readOnly={!manual} value={text.lat} onChange={(e) => typeCoordinate({ lat: e.target.value })} onBlur={showTyped} /></div>
          <div className="field"><label htmlFor="areaLon">Centre longitude</label><input id="areaLon" name="areaLon" className="input" readOnly={!manual} value={text.lon} onChange={(e) => typeCoordinate({ lon: e.target.value })} onBlur={showTyped} /></div>
          <div className="field"><label htmlFor="areaRadiusM">Radius (metres)</label><input id="areaRadiusM" name="areaRadiusM" className="input" readOnly={!manual} value={radiusText} onChange={(e) => setRadiusText(e.target.value)} onBlur={showTyped} /></div>
        </div>
      </details>
    </div>
  );
}
