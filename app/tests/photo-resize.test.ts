import sharp from "sharp";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { postForm } from "@/lib/client-api";
import {
  FALLBACK_STEPS,
  PHOTO_BUDGET_BYTES,
  PHOTO_JPEG_QUALITY,
  PHOTO_LONGEST_SIDE_PX,
  REQUEST_BODY_LIMIT_BYTES,
  TOO_LARGE_MESSAGE,
  budgetProblem,
  fitPhoto,
  fitWithin,
  photoShare,
  photoTooBigMessage,
  type Size,
} from "@/lib/evidence/photo-limits";
import { assertPhotoBytes } from "@/lib/activations/submission-form";
import { ApiError } from "@/lib/http/errors";
import type { PhotoInput } from "@/lib/activations/submit";

/**
 * Defect 16: a phone camera photo is several MB and two of them exceeded
 * Vercel's 4.5 MB request body limit. These tests cover the sizing logic with
 * real JPEG bytes (sharp stands in for the browser's canvas encoder, whose
 * quality scale differs slightly) and the messages the agent sees. The canvas
 * path itself is checked in a real browser: docs/chapter5/evidence/hosted/defect-16.
 */
const PHONE: Size = { width: 4000, height: 3000 }; // 12 megapixels, a common phone sensor size

/** A photo-like image: smooth colour with mild sensor noise, about the entropy of a daylight shot. */
function photoPixels({ width, height }: Size): Buffer {
  const raw = Buffer.alloc(width * height * 3);
  let seed = 12345;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const noise = ((seed >> 16) % 9) - 4;
      const i = (y * width + x) * 3;
      raw[i] = Math.max(0, Math.min(255, 90 + (x * 120) / width + noise));
      raw[i + 1] = Math.max(0, Math.min(255, 70 + (y * 140) / height + noise));
      raw[i + 2] = Math.max(0, Math.min(255, 150 - ((x + y) * 60) / (width + height) + noise));
    }
  }
  return raw;
}

let original: Buffer;
let pixels: Buffer;

beforeAll(async () => {
  pixels = photoPixels(PHONE);
  original = await sharp(pixels, { raw: { width: PHONE.width, height: PHONE.height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}, 60_000);

const encoder = (source: Buffer, raw: { width: number; height: number }) => async (size: Size, quality: number) => {
  const bytes = await sharp(source, { raw: { ...raw, channels: 3 } })
    .resize(size.width, size.height)
    .jpeg({ quality: Math.round(quality * 100) })
    .toBuffer();
  return { size: bytes.length, bytes, width: size.width, height: size.height };
};

describe("photo dimensions", () => {
  it("scales the longest side to the limit and keeps the shape", () => {
    expect(fitWithin({ width: 4000, height: 3000 }, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin({ width: 3000, height: 4000 }, 1600)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin({ width: 4032, height: 3024 }, 1600).width / fitWithin({ width: 4032, height: 3024 }, 1600).height).toBeCloseTo(4 / 3, 2);
  });

  it("never enlarges a photo that is already small", () => {
    expect(fitWithin({ width: 800, height: 600 }, 1600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin({ width: 1600, height: 1600 }, 1600)).toEqual({ width: 1600, height: 1600 });
  });

  it("the limits leave room under the platform's body limit", () => {
    expect(PHOTO_LONGEST_SIDE_PX).toBe(1600);
    expect(PHOTO_JPEG_QUALITY).toBe(0.8);
    expect(PHOTO_BUDGET_BYTES).toBeLessThan(REQUEST_BODY_LIMIT_BYTES - 500_000);
  });
});

describe("a phone photo is brought under its share of the budget", () => {
  it("starts from a photo far over the platform limit by itself", () => {
    expect(original.length).toBeGreaterThan(REQUEST_BODY_LIMIT_BYTES / 2);
  });

  it("two photos: re-encoded at 1600 px and 0.8, output within bounds", async () => {
    const ceiling = photoShare(2);
    const fitted = await fitPhoto(PHONE, ceiling, encoder(pixels, PHONE));
    expect(fitted.fits).toBe(true);
    expect(Math.max(fitted.size.width, fitted.size.height)).toBeLessThanOrEqual(1600);
    expect(fitted.size).toEqual({ width: 1600, height: 1200 });
    expect(fitted.quality).toBe(0.8);
    expect(fitted.encoded.size).toBeLessThanOrEqual(ceiling);
    expect(fitted.encoded.size).toBeLessThan(original.length / 4);
    const meta = await sharp(fitted.encoded.bytes).metadata();
    expect({ w: meta.width, h: meta.height, format: meta.format }).toEqual({ w: 1600, h: 1200, format: "jpeg" });
  }, 60_000);

  it("the most photos a form allows still stay under the budget, hence under the platform limit", async () => {
    const maxPhotos = 13; // MAX_JOB_PHOTOS (12) and one proof of activation
    const ceiling = photoShare(maxPhotos);
    const fitted = await fitPhoto(PHONE, ceiling, encoder(pixels, PHONE));
    expect(fitted.fits).toBe(true);
    expect(fitted.encoded.size).toBeLessThanOrEqual(ceiling);
    const total = fitted.encoded.size * maxPhotos;
    expect(total).toBeLessThanOrEqual(PHOTO_BUDGET_BYTES);
    expect(total).toBeLessThan(REQUEST_BODY_LIMIT_BYTES);
    expect(budgetProblem(total)).toBeNull();
  }, 60_000);

  it("steps down through the fallback settings, one attempt per step at most", async () => {
    const seen: { size: Size; quality: number }[] = [];
    const fake = async (size: Size, quality: number) => {
      seen.push({ size, quality });
      return { size: size.width * size.height * quality * 0.2 };
    };
    const fitted = await fitPhoto(PHONE, 100_000, fake);
    expect(seen.length).toBeLessThanOrEqual(1 + FALLBACK_STEPS.length);
    expect(seen[0]).toEqual({ size: { width: 1600, height: 1200 }, quality: 0.8 });
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i].size.width * seen[i].size.height * seen[i].quality).toBeLessThan(seen[i - 1].size.width * seen[i - 1].size.height * seen[i - 1].quality);
    }
    expect(fitted.fits).toBe(fitted.encoded.size <= 100_000);
  });

  it("reports a photo that cannot be made small enough instead of passing it on", async () => {
    const calls: number[] = [];
    const impossible = async (size: Size) => {
      calls.push(size.width);
      return { size: 10_000_000 };
    };
    const fitted = await fitPhoto(PHONE, 1_000, impossible);
    expect(fitted.fits).toBe(false);
    expect(calls.length).toBe(1 + FALLBACK_STEPS.length);
    expect(Math.min(...calls)).toBe(640);
  });
});

describe("messages the agent sees", () => {
  it("over the budget: says how much, and what to do", () => {
    expect(budgetProblem(PHOTO_BUDGET_BYTES)).toBeNull();
    const message = budgetProblem(PHOTO_BUDGET_BYTES + 1_000_000);
    expect(message).toContain("4.5 MB");
    expect(message).toContain("3.5 MB");
    expect(message).toMatch(/Remove one or more photos, or take them again/);
  });

  it("one photo that cannot be shrunk is named", () => {
    expect(photoTooBigMessage("IMG_0042.jpg")).toBe("IMG_0042.jpg is too large to send, even after shrinking it. Take the photo again with the camera.");
  });

  describe("HTTP 413 from the platform", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("replaces 'Request failed (413)' with plain instructions", async () => {
      vi.stubGlobal("fetch", async () => new Response("Request Entity Too Large", { status: 413 }));
      const result = await postForm("/api/agent/activations", new FormData());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(413);
      expect(result.message).toBe(TOO_LARGE_MESSAGE);
      expect(result.message).not.toMatch(/413/);
    });

    it("does not change the message of any other failure", async () => {
      vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
      const result = await postForm("/api/agent/activations", new FormData());
      expect(result.ok === false && result.message).toBe("Request failed (500).");
    });
  });
});

describe("the server keeps refusing an oversize body", () => {
  const photo = (bytes: number): PhotoInput => ({
    file: new File([new Uint8Array(bytes)], "p.jpg", { type: "image/jpeg" }),
    capturedAt: null,
    gpsLat: null,
    gpsLon: null,
    gpsAccuracyM: null,
    locationSource: "none",
  });

  it("accepts photos within the platform limit", () => {
    expect(() => assertPhotoBytes([photo(2_000_000), photo(2_000_000)])).not.toThrow();
  });

  it("refuses photos over it with 413 and the same plain message", () => {
    try {
      assertPhotoBytes([photo(3_000_000), photo(2_000_000)]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(413);
      expect((error as ApiError).message).toBe(TOO_LARGE_MESSAGE);
    }
  });
});
