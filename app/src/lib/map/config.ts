import { REGIONS } from "@/lib/geo";

/**
 * The map and place-search services the job-area picker uses. The defaults
 * are OpenStreetMap's own public services, used within their usage policies
 * (operations.osmfoundation.org/policies/tiles and /policies/nominatim):
 * tiles are requested only for what a person is looking at, the attribution
 * is always on the map, and a place search runs only when the person asks
 * for one. Both policies ask that an app can switch a service off or move to
 * another without a code change, so each address can be replaced by an
 * environment variable, and NEXT_PUBLIC_GEOCODER_URL=off removes place
 * search altogether. NEXT_PUBLIC_ variables are read at build time.
 */
const DEFAULT_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const DEFAULT_GEOCODER_URL = "https://nominatim.openstreetmap.org";

export const TILE_URL = process.env.NEXT_PUBLIC_MAP_TILE_URL || DEFAULT_TILE_URL;

/** Required on the map by the OpenStreetMap licence; never hidden. */
export const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** Null when place search is switched off. */
export const GEOCODER_URL: string | null = process.env.NEXT_PUBLIC_GEOCODER_URL === "off" ? null : process.env.NEXT_PUBLIC_GEOCODER_URL || DEFAULT_GEOCODER_URL;

/**
 * Hosts that scripts driving a headless browser must block: the tile policy
 * forbids automated clients making the map load tiles, and the search policy
 * forbids systematic queries. scripts/audit-accessibility.ts,
 * scripts/capture-screenshots.ts and scripts/hosted-verify.ts abort every
 * request to these.
 */
export const MAP_HOSTS = [new URL(DEFAULT_TILE_URL).hostname, new URL(DEFAULT_GEOCODER_URL).hostname];

/** Where the map opens before a pin is placed: the first of the model's urban centres (Nairobi), at city zoom. */
export const DEFAULT_VIEW = { lat: REGIONS[0].lat, lon: REGIONS[0].lon, zoom: 11 };

/** Zoom used when the map moves to a place or to the person's location without a bounding box. */
export const PLACE_ZOOM = 15;
