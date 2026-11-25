/**
 * Place search for the job-area picker, against a Nominatim server. The
 * public server's usage policy is kept by construction:
 * - a search runs only when the person asks for one (Enter or the Search
 *   button). There is no search-as-you-type: the policy forbids
 *   auto-complete built on the public API, debounced or not;
 * - at most one request per second from this page (MIN_INTERVAL_MS);
 * - each query's results are cached for the page's lifetime, so repeating a
 *   search sends nothing;
 * - the browser identifies the app with its Referer, as the policy asks of a
 *   web page (a page cannot set its own User-Agent).
 */
export type Place = {
  name: string;
  lat: number;
  lon: number;
  /** South, north, west, east, when the server gives a bounding box. */
  bounds: [number, number, number, number] | null;
};

export const MIN_INTERVAL_MS = 1000;
export const RESULT_LIMIT = 5;
/** Results are limited to Kenya, where every job is. */
export const COUNTRY_CODES = "ke";

export function searchUrl(base: string, query: string): string {
  const url = new URL("/search", base);
  url.search = new URLSearchParams({ format: "jsonv2", q: query, limit: String(RESULT_LIMIT), countrycodes: COUNTRY_CODES, "accept-language": "en" }).toString();
  return url.toString();
}

function toNumber(value: unknown): number | null {
  const number = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

/** The places in a Nominatim JSON answer; anything malformed is left out. */
export function parsePlaces(body: unknown): Place[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((item: Record<string, unknown>) => {
    const lat = toNumber(item?.lat);
    const lon = toNumber(item?.lon);
    if (lat === null || lon === null || typeof item.display_name !== "string") return [];
    const box = Array.isArray(item.boundingbox) ? item.boundingbox.map(toNumber) : [];
    const bounds = box.length === 4 && box.every((n) => n !== null) ? (box as [number, number, number, number]) : null;
    return [{ name: item.display_name, lat, lon, bounds }];
  });
}

type Deps = {
  fetcher?: typeof fetch;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
};

/** A search function for one page: spaced at least MIN_INTERVAL_MS apart, with a cache. */
export function createGeocoder(base: string, { fetcher = fetch, now = Date.now, wait = (ms) => new Promise((done) => setTimeout(done, ms)) }: Deps = {}) {
  const cache = new Map<string, Place[]>();
  let nextAllowed = 0;
  return async function search(query: string): Promise<Place[]> {
    const key = query.trim().replace(/\s+/g, " ").toLowerCase();
    if (key === "") return [];
    const cached = cache.get(key);
    if (cached) return cached;
    const at = Math.max(now(), nextAllowed);
    nextAllowed = at + MIN_INTERVAL_MS;
    if (at > now()) await wait(at - now());
    const response = await fetcher(searchUrl(base, query.trim()), { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Place search answered ${response.status}.`);
    const places = parsePlaces(await response.json());
    cache.set(key, places);
    return places;
  };
}
