"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Circle, LatLngBoundsExpression, Map as LMap, Marker } from "leaflet";
import { DEFAULT_VIEW, TILE_ATTRIBUTION, TILE_URL } from "@/lib/map/config";

export type Point = { lat: number; lon: number };
/** Where to move the map: to a point at a zoom, or to fit a box (south, north, west, east). */
export type Move = { lat: number; lon: number; zoom: number } | { bounds: [number, number, number, number] };
/** A move request; `key` changes on every request, so asking for the same place twice still moves. */
export type View = Move & { key: number };
/** What the picker may ask of the map once it has loaded. */
export type MapApi = { centre: () => Point };

type Props = {
  pin: Point | null;
  radiusM: number;
  onPick: (point: Point) => void;
  view: View | null;
  apiRef: MutableRefObject<MapApi | null>;
  label: string;
};

/**
 * An OpenStreetMap map with one draggable pin and the job area's circle.
 * Leaflet is loaded in the browser only, when the map first renders. The map
 * draws and reports; the picker around it owns the values, so the form's
 * fields are filled the same way whether the pin came from the map, a search
 * or the device's location. Leaflet's own keyboard support pans and zooms the
 * map; the picker adds a button that puts the pin at the map's centre.
 */
export function LeafletMap({ pin, radiusM, onPick, view, apiRef, label }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<LMap | null>(null);
  const marker = useRef<Marker | null>(null);
  const circle = useRef<Circle | null>(null);
  const leaflet = useRef<typeof import("leaflet") | null>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let gone = false;
    void import("leaflet").then((module) => {
      if (gone || !box.current) return;
      const L = module.default ?? module;
      leaflet.current = L;
      const m = L.map(box.current, { center: [DEFAULT_VIEW.lat, DEFAULT_VIEW.lon], zoom: DEFAULT_VIEW.zoom, keyboard: true });
      L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, maxZoom: 19 }).addTo(m);
      m.on("click", (event) => pick.current({ lat: event.latlng.lat, lon: event.latlng.lng }));
      map.current = m;
      apiRef.current = { centre: () => ({ lat: m.getCenter().lat, lon: m.getCenter().lng }) };
      setReady(true);
    });
    return () => {
      gone = true;
      apiRef.current = null;
      map.current?.remove();
      map.current = null;
    };
  }, [apiRef]);

  // The pin and the circle follow the values.
  useEffect(() => {
    const L = leaflet.current;
    const m = map.current;
    if (!ready || !L || !m) return;
    if (!pin) {
      marker.current?.remove();
      circle.current?.remove();
      marker.current = null;
      circle.current = null;
      return;
    }
    const at: [number, number] = [pin.lat, pin.lon];
    if (!marker.current) {
      // A 28 px square turned 45 degrees: its point is 14 * (1 + sqrt 2), about 34 px, below the top.
      const icon = L.divIcon({ className: "map-pin", iconSize: [28, 28], iconAnchor: [14, 34] });
      marker.current = L.marker(at, { draggable: true, icon, title: "Centre of the job area", alt: "Centre of the job area", keyboard: true }).addTo(m);
      marker.current.on("dragend", () => {
        const moved = marker.current!.getLatLng();
        pick.current({ lat: moved.lat, lon: moved.lng });
      });
      circle.current = L.circle(at, { radius: radiusM, className: "map-circle", interactive: false }).addTo(m);
    } else {
      marker.current.setLatLng(at);
      circle.current!.setLatLng(at);
      circle.current!.setRadius(radiusM);
    }
  }, [ready, pin?.lat, pin?.lon, radiusM]); // eslint-disable-line react-hooks/exhaustive-deps

  // A larger radius than the map shows: zoom out to the whole circle.
  useEffect(() => {
    const m = map.current;
    if (!ready || !m || !circle.current) return;
    const bounds = circle.current.getBounds();
    if (!m.getBounds().contains(bounds)) m.fitBounds(bounds, { padding: [16, 16] });
  }, [ready, radiusM]);

  useEffect(() => {
    const m = map.current;
    if (!ready || !m || !view) return;
    if ("bounds" in view) {
      const [south, north, west, east] = view.bounds;
      m.fitBounds([[south, west], [north, east]] as LatLngBoundsExpression);
    } else {
      m.setView([view.lat, view.lon], view.zoom);
    }
  }, [ready, view]);

  return <div ref={box} className="map-canvas" role="region" aria-label={label} />;
}
