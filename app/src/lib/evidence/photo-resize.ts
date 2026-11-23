import { fitPhoto, fitWithin, PHOTO_LONGEST_SIDE_PX, type Size } from "./photo-limits";

/**
 * Shrinks a photo in the browser before upload (defect 16). Browser only: it
 * needs createImageBitmap and a canvas. The limits and the stepping logic are
 * in photo-limits.ts.
 *
 * The result keeps the original file's modified time, which is where the
 * capture time stamp comes from. Re-encoding drops the photo's EXIF block,
 * including any GPS tags; the app's location stamp comes from the device's own
 * position at the moment the photo is added, not from EXIF.
 */
export type Shrunk = { file: File; changed: boolean; fits: boolean };

type Drawable = { bitmap: ImageBitmap; size: Size };

async function decode(file: File): Promise<Drawable | null> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { bitmap, size: { width: bitmap.width, height: bitmap.height } };
  } catch {
    return null;
  }
}

async function toJpeg(bitmap: ImageBitmap, size: Size, quality: number): Promise<Blob> {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(size.width, size.height);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, size.width, size.height);
    return canvas.convertToBlob({ type: "image/jpeg", quality });
  }
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, size.width, size.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The photo could not be re-encoded."))), "image/jpeg", quality),
  );
}

function jpegName(name: string): string {
  return `${name.replace(/\.[^.]+$/, "") || "photo"}.jpg`;
}

/**
 * Returns the photo scaled and re-encoded to fit within `ceiling` bytes. A JPEG
 * that is already small enough is returned untouched. A file the browser cannot
 * decode (for example HEIC outside Safari) is returned as it is when it is
 * within the ceiling, and otherwise reported as not fitting.
 */
export async function shrinkPhoto(file: File, ceiling: number): Promise<Shrunk> {
  const drawable = await decode(file);
  if (!drawable) return { file, changed: false, fits: file.size <= ceiling };
  const { bitmap, size } = drawable;
  try {
    const small = fitWithin(size, PHOTO_LONGEST_SIDE_PX);
    const already = file.type === "image/jpeg" && file.size <= ceiling && small.width === size.width && small.height === size.height;
    if (already) return { file, changed: false, fits: true };
    const fitted = await fitPhoto(size, ceiling, async (target, quality) => toJpeg(bitmap, target, quality));
    const out = new File([fitted.encoded], jpegName(file.name), { type: "image/jpeg", lastModified: file.lastModified });
    return { file: out, changed: true, fits: fitted.fits };
  } finally {
    bitmap.close();
  }
}
