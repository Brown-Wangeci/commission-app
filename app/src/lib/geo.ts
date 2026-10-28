/**
 * Geography helpers. The region list and the distance approximation mirror
 * the scoring model so `ip_location_mismatch_flag` means the same thing here
 * as in training:
 * - regions: `population.urban_centers` in config/generator.yaml (repository
 *   root). The codes are the model's; the display names are the cities at
 *   those coordinates.
 * - nearest region: smallest squared difference in degrees, as
 *   src/generator/features.py `_implied_region` computes it.
 */
export type Region = { code: string; name: string; lat: number; lon: number };

export const REGIONS: readonly Region[] = [
  { code: "region_a", name: "Nairobi", lat: -1.2921, lon: 36.8219 },
  { code: "region_b", name: "Kisumu", lat: -0.1022, lon: 34.7617 },
  { code: "region_c", name: "Mombasa", lat: -4.0435, lon: 39.6682 },
  { code: "region_d", name: "Eldoret", lat: 0.5143, lon: 35.2698 },
];

export function nearestRegion(lat: number, lon: number): Region {
  let best = REGIONS[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const region of REGIONS) {
    const squared = (lat - region.lat) ** 2 + (lon - region.lon) ** 2;
    if (squared < bestDistance) {
      best = region;
      bestDistance = squared;
    }
  }
  return best;
}

export function regionByCode(code: string): Region | undefined {
  return REGIONS.find((region) => region.code === code);
}

const EARTH_RADIUS_KM = 6371.0088;

/** Great-circle distance in kilometres. */
export function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type JobArea = { areaLat: number; areaLon: number; areaRadiusM: number };

/** Kilometres outside the job area's edge; 0 when inside. */
export function kmOutsideArea(area: JobArea, lat: number, lon: number): number {
  const fromCentre = distanceKm(area.areaLat, area.areaLon, lat, lon);
  return Math.max(0, fromCentre - area.areaRadiusM / 1000);
}
