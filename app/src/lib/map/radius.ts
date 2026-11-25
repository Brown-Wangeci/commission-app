/**
 * The job area's radius slider moves through these steps rather than every
 * metre, so a phone thumb can reach both a market stall's 100 m and a town's
 * 20 km. They run from the smallest to the largest radius the server accepts
 * (50 m to 50 km, jobInputSchema in src/lib/jobs/jobs.ts) and include the
 * form's default (DEFAULT_RADIUS_M, 700 m); tests/ui-pass-maps.test.tsx
 * checks both.
 */
export const RADIUS_STEPS_M: readonly number[] = [
  50, 100, 150, 200, 300, 400, 500, 700, 1000, 1500, 2000, 3000, 5000, 7500, 10_000, 15_000, 20_000, 30_000, 50_000,
];

/** The step nearest a radius, for a value that is not one of the steps. */
export function radiusStepIndex(radiusM: number): number {
  let best = 0;
  for (let i = 1; i < RADIUS_STEPS_M.length; i += 1) {
    if (Math.abs(RADIUS_STEPS_M[i] - radiusM) < Math.abs(RADIUS_STEPS_M[best] - radiusM)) best = i;
  }
  return best;
}

/** "700 m", "1.5 km", "20 km". */
export function radiusLabel(radiusM: number): string {
  if (radiusM < 1000) return `${radiusM} m`;
  const km = radiusM / 1000;
  return `${Number.isInteger(km) ? km : km.toFixed(1)} km`;
}
