/**
 * Size limits for photos sent from the browser (defect 16), and the pure logic
 * that applies them. Nothing here touches the DOM, so it is tested directly;
 * the browser part that decodes and re-encodes lives in photo-resize.ts.
 *
 * Why it exists: a phone camera photo is 3 to 8 MB, and Vercel refuses a
 * request body over about 4.5 MB with an HTTP 413 before the app sees it. Two
 * camera photos were enough to fail.
 */

/** Vercel's limit on a function's request body (Vercel documentation: 4.5 MB). Source: platform specification. */
export const REQUEST_BODY_LIMIT_BYTES = 4_500_000;

/**
 * The most photo bytes the browser sends in one request. Source: assumption.
 * It leaves about 1 MB under the platform limit for the multipart framing, the
 * form values and the per-photo metadata.
 */
export const PHOTO_BUDGET_BYTES = 3_500_000;

/** A photo is first scaled so its longest side is at most this. Source: assumption (the defect report suggested about 1600). */
export const PHOTO_LONGEST_SIDE_PX = 1600;

/** The JPEG quality of the first attempt. Source: assumption (the defect report suggested about 0.8). */
export const PHOTO_JPEG_QUALITY = 0.8;

/**
 * Tried in order when a photo is still over its share of the budget after the
 * first attempt, which only happens when the form allows many photos. Source:
 * assumption.
 */
export const FALLBACK_STEPS: readonly { side: number; quality: number }[] = [
  { side: 1280, quality: 0.7 },
  { side: 1024, quality: 0.6 },
  { side: 800, quality: 0.5 },
  { side: 640, quality: 0.45 },
];

export type Size = { width: number; height: number };

/** What the agent is told when the server (or Vercel) answers 413. */
export const TOO_LARGE_MESSAGE =
  "The photos are too large to send together. Remove one or more photos, or take them again, then submit again.";

/** The new size with the longest side at most `longestSide`, the same shape, never enlarged. */
export function fitWithin(size: Size, longestSide: number): Size {
  const longest = Math.max(size.width, size.height);
  if (longest <= longestSide) return { ...size };
  const scale = longestSide / longest;
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
}

/**
 * The bytes one photo may take: an equal share of the budget for the most
 * photos the form can hold. Every photo within its share means a full form is
 * within the budget, however many photos the agent adds.
 */
export function photoShare(maxPhotos: number, budget: number = PHOTO_BUDGET_BYTES): number {
  return Math.floor(budget / Math.max(1, maxPhotos));
}

export type Encoded = { size: number };
export type Encoder<T extends Encoded> = (size: Size, quality: number) => Promise<T>;
export type Fitted<T extends Encoded> = { encoded: T; size: Size; quality: number; fits: boolean };

/**
 * Encodes a photo at the first setting and steps down until it is within
 * `ceiling`. When even the smallest setting is over, it returns that attempt
 * with `fits` false and the caller refuses the photo.
 */
export async function fitPhoto<T extends Encoded>(source: Size, ceiling: number, encode: Encoder<T>): Promise<Fitted<T>> {
  const steps = [{ side: PHOTO_LONGEST_SIDE_PX, quality: PHOTO_JPEG_QUALITY }, ...FALLBACK_STEPS];
  let last: Fitted<T> | null = null;
  for (const step of steps) {
    const size = fitWithin(source, step.side);
    const encoded = await encode(size, step.quality);
    last = { encoded, size, quality: step.quality, fits: encoded.size <= ceiling };
    if (last.fits) return last;
  }
  return last as Fitted<T>;
}

function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}

/** The message for photos that add up to more than the budget, or null when they fit. */
export function budgetProblem(totalBytes: number, budget: number = PHOTO_BUDGET_BYTES): string | null {
  if (totalBytes <= budget) return null;
  return `These photos add up to ${megabytes(totalBytes)} MB, more than the ${megabytes(budget)} MB that can be sent at once. Remove one or more photos, or take them again, then submit again.`;
}

/** The message for one photo that cannot be made small enough. */
export function photoTooBigMessage(name: string): string {
  return `${name} is too large to send, even after shrinking it. Take the photo again with the camera.`;
}
