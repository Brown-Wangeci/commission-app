"use client";

import { useMemo, useState, type KeyboardEvent } from "react";
import type { FieldErrors } from "@/lib/client-api";
import { HOME_LOCATION_REQUIRED, OUT_OF_RANGE, coordinate, typedLocationProblem, validPoint, type Point } from "@/lib/location";
import { GEOCODER_URL } from "@/lib/map/config";
import { createGeocoder, type Place } from "@/lib/map/geocode";
import { ManualToggle, TypedNotes } from "@/components/ManualCoordinates";

/** The chosen base: where it is, the place's full name when it came from a search, and whether it was typed. */
export type HomeBase = { lat: number; lon: number; name: string | null; typed?: boolean };

type Origin = "search" | "device" | "typed";

/** What the form says has been chosen. */
export function chosenText(base: HomeBase | null): string {
  if (!base) return "No location chosen yet.";
  if (base.typed) return "Chosen: the coordinates you entered.";
  return base.name ? `Chosen: ${base.name}` : "Chosen: your current location.";
}

function FieldError({ errors, name }: { errors: FieldErrors; name: string }) {
  return errors[name] ? <span className="field-error">{errors[name]}</span> : null;
}

/**
 * Where an agent is based, on sign-up: the same place search as the job-area
 * picker (only on Enter or the Search button, through createGeocoder, which
 * keeps the search policy) or the device's location. No map. It fills the
 * fields the form always sent: homeAreaName, which stays editable, and
 * homeLat and homeLon, shown under Advanced, read-only unless the person
 * chooses to enter coordinates themselves.
 */
export function HomeBasePicker({ errors }: { errors: FieldErrors }) {
  // The two coordinate fields are the one source: search, the device and typing all write them.
  const [text, setText] = useState({ lat: "", lon: "" });
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [placeName, setPlaceName] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [areaName, setAreaName] = useState("");
  const [autoName, setAutoName] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Place[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const search = useMemo(() => (GEOCODER_URL ? createGeocoder(GEOCODER_URL) : null), []);

  async function runSearch() {
    if (!search || query.trim() === "") return;
    setSearching(true);
    setNote(null);
    try {
      const places = await search(query);
      setResults(places);
      if (places.length === 0) setNote("No place found in Kenya with that name. Try a nearby landmark or town, or use your location.");
    } catch {
      setResults(null);
      setNote("Place search is not available right now. Use your location, or try the search again later.");
    }
    setSearching(false);
  }

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    // Enter searches; it must not submit the sign-up form around this field.
    if (event.key !== "Enter") return;
    event.preventDefault();
    void runSearch();
  }

  /** Fills the name from a search, or clears a name an earlier search filled in; a typed name is kept. */
  function fillName(next: string | null) {
    if (areaName.trim() === "" || areaName === autoName) setAreaName(next ?? "");
    setAutoName(next);
  }

  function put(point: Point, from: Origin, name: string | null) {
    setText({ lat: coordinate(point.lat), lon: coordinate(point.lon) });
    setOrigin(from);
    setPlaceName(name);
  }

  function typeCoordinate(patch: Partial<typeof text>) {
    setText((current) => ({ ...current, ...patch }));
    setOrigin("typed");
    fillName(null);
  }

  /** Switching typing off keeps a usable point and drops an unusable one, so a read-only field never holds a bad value. */
  function toggleManual(on: boolean) {
    setManual(on);
    if (on || validPoint(text.lat, text.lon)) return;
    setText({ lat: "", lon: "" });
    setOrigin(null);
  }

  function choose(place: Place) {
    put(place, "search", place.name);
    fillName(place.name.split(",")[0].trim());
    setResults(null);
    setNote(null);
  }

  function useMyLocation() {
    const failed = () => setNote("Your location is not available in this browser. Search for your area instead.");
    if (!navigator.geolocation) return failed();
    navigator.geolocation.getCurrentPosition((position) => {
      put({ lat: position.coords.latitude, lon: position.coords.longitude }, "device", null);
      fillName(null);
      setResults(null);
      setNote(null);
    }, failed);
  }

  const point = validPoint(text.lat, text.lon);
  const base = point ? { ...point, name: origin === "search" ? placeName : null, typed: origin === "typed" } : null;
  // A message about the location goes once the point is usable; while typing, the note about the typed values stands in for it.
  const reported = errors.homeLat || errors.homeLon;
  const answered = (reported === HOME_LOCATION_REQUIRED || reported === OUT_OF_RANGE) && point !== null;
  const typedProblem = origin === "typed" && typedLocationProblem(text.lat, text.lon) !== null;
  const locationError = answered || typedProblem ? undefined : reported;
  return (
    <div className="stack">
      {search && (
        <div className="field">
          <label htmlFor="homeSearch">Search for your area</label>
          <div className="map-search">
            <input id="homeSearch" type="search" className="input" value={query} placeholder="e.g. Kariobangi North" onChange={(e) => setQuery(e.target.value)} onKeyDown={onSearchKey} />
            <button type="button" className="btn" onClick={() => void runSearch()} disabled={searching || query.trim() === ""}>{searching ? "Searching" : "Search"}</button>
          </div>
          {results && results.length > 0 && (
            <ul className="map-results" aria-label="Places found">
              {results.map((place) => (
                <li key={`${place.lat},${place.lon}`}><button type="button" className="map-result" onClick={() => choose(place)}>{place.name}</button></li>
              ))}
            </ul>
          )}
          <span className="hint">Search results come from OpenStreetMap.</span>
        </div>
      )}
      <button type="button" className="btn small" onClick={useMyLocation}>Use my location</button>
      {note && <p className="small muted" role="status">{note}</p>}
      <p className="small strong" role="status">{chosenText(base)}</p>
      {locationError && <span className="field-error" role="alert">{locationError}</span>}
      {origin === "typed" && <TypedNotes lat={text.lat} lon={text.lon} />}
      <div className="field">
        <label htmlFor="homeAreaName">Where you are based</label>
        <input id="homeAreaName" name="homeAreaName" className="input" value={areaName} onChange={(e) => setAreaName(e.target.value)} />
        <span className="hint">The name of your area. A search fills it in; you can change it.</span>
        <FieldError errors={errors} name="homeAreaName" />
      </div>
      <details className="help-more">
        <summary className="small">Advanced: the values sent</summary>
        <ManualToggle checked={manual} onChange={toggleManual} without="search and your location" />
        <div className="grid-2" style={{ marginTop: 8 }}>
          <div className="field"><label htmlFor="homeLat">Latitude</label><input id="homeLat" name="homeLat" className="input" readOnly={!manual} value={text.lat} onChange={(e) => typeCoordinate({ lat: e.target.value })} /></div>
          <div className="field"><label htmlFor="homeLon">Longitude</label><input id="homeLon" name="homeLon" className="input" readOnly={!manual} value={text.lon} onChange={(e) => typeCoordinate({ lon: e.target.value })} /></div>
        </div>
      </details>
    </div>
  );
}
