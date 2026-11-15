import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The evidence storage boundary. Local disk for development and tests, a
 * private Vercel Blob store for the hosted app, chosen without any change to
 * callers or to the stored path. The Blob SDK is mocked: the suite never
 * reaches Vercel.
 */
const blob = vi.hoisted(() => {
  const store = new Map<string, { bytes: Buffer; contentType: string }>();
  return {
    store,
    put: vi.fn(async (pathname: string, body: Buffer, options: { contentType: string }) => {
      store.set(pathname, { bytes: Buffer.from(body), contentType: options.contentType });
      return { pathname, url: `https://store.private.blob.vercel-storage.com/${pathname}` };
    }),
    get: vi.fn(async (pathname: string) => {
      const found = store.get(pathname);
      if (!found) return null;
      return { statusCode: 200, stream: new Response(new Uint8Array(found.bytes)).body, headers: new Headers(), blob: { pathname, contentType: found.contentType, size: found.bytes.length } };
    }),
    list: vi.fn(async ({ prefix }: { prefix: string }) => ({
      blobs: [...store.keys()].filter((pathname) => pathname.startsWith(prefix)).map((pathname) => ({ pathname })),
      hasMore: false,
    })),
    del: vi.fn(async (pathnames: string[]) => {
      for (const pathname of pathnames) store.delete(pathname);
    }),
  };
});
vi.mock("@vercel/blob", () => ({ put: blob.put, get: blob.get, list: blob.list, del: blob.del }));

import { backendName } from "@/lib/evidence/storage-backend";
import { evidenceBackendName, readStored, removeActivationFiles, removeAllEvidence, storeBytes } from "@/lib/evidence/storage";

const saved = { EVIDENCE_STORAGE: process.env.EVIDENCE_STORAGE, VERCEL: process.env.VERCEL };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

beforeEach(() => {
  blob.store.clear();
  vi.clearAllMocks();
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("choosing the backend", () => {
  it("is disk locally and in tests, blob on Vercel, and EVIDENCE_STORAGE overrides both", () => {
    expect(backendName({})).toBe("disk");
    expect(backendName({ VERCEL: "1" })).toBe("blob");
    expect(backendName({ VERCEL: "1", EVIDENCE_STORAGE: "disk" })).toBe("disk");
    expect(backendName({ EVIDENCE_STORAGE: "blob" })).toBe("blob");
    expect(() => backendName({ EVIDENCE_STORAGE: "s3" })).toThrow(/"disk" or "blob"/);
  });

  it("the suite itself runs on disk", () => {
    delete process.env.EVIDENCE_STORAGE;
    delete process.env.VERCEL;
    expect(evidenceBackendName()).toBe("disk");
  });
});

describe("disk backend", () => {
  beforeEach(() => {
    process.env.EVIDENCE_STORAGE = "disk";
  });

  it("writes, reads back and removes, never touching Blob", async () => {
    const stored = await storeBytes("act-disk-1", "photo_1.png", PNG, "image/png", "receipt.png");
    expect(stored.storagePath).toBe("act-disk-1/photo_1.png");
    expect(new Uint8Array(await readStored(stored.storagePath))).toEqual(PNG);
    await removeActivationFiles("act-disk-1");
    await expect(readStored(stored.storagePath)).rejects.toMatchObject({ status: 404 });
    expect(blob.put).not.toHaveBeenCalled();
    expect(blob.get).not.toHaveBeenCalled();
  });
});

describe("blob backend", () => {
  beforeEach(() => {
    process.env.EVIDENCE_STORAGE = "blob";
  });

  it("stores privately under the same path the row records, overwriting like disk", async () => {
    const stored = await storeBytes("act-blob-1", "photo_1.png", PNG, "image/png", "receipt.png");
    expect(stored.storagePath).toBe("act-blob-1/photo_1.png");
    expect(blob.put).toHaveBeenCalledWith("evidence/act-blob-1/photo_1.png", expect.any(Buffer), {
      access: "private",
      contentType: "image/png",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  });

  it("reads back the same bytes, uncached, and a missing file is a 404", async () => {
    const stored = await storeBytes("act-blob-2", "photo_1.png", PNG, "image/png", "receipt.png");
    expect(new Uint8Array(await readStored(stored.storagePath))).toEqual(PNG);
    expect(blob.get).toHaveBeenCalledWith("evidence/act-blob-2/photo_1.png", { access: "private", useCache: false });
    await expect(readStored("act-blob-2/photo_9.png")).rejects.toMatchObject({ status: 404 });
  });

  it("removes one activation's files and leaves the others", async () => {
    await storeBytes("act-a", "photo_1.png", PNG, "image/png", "a.png");
    await storeBytes("act-a", "photo_2.png", PNG, "image/png", "b.png");
    await storeBytes("act-ab", "photo_1.png", PNG, "image/png", "c.png");
    await removeActivationFiles("act-a");
    expect([...blob.store.keys()]).toEqual(["evidence/act-ab/photo_1.png"]);
  });

  it("the seed's reset empties only the evidence prefix", async () => {
    await storeBytes("act-c", "photo_1.png", PNG, "image/png", "a.png");
    blob.store.set("other/keep.txt", { bytes: Buffer.from("x"), contentType: "text/plain" });
    await removeAllEvidence();
    expect([...blob.store.keys()]).toEqual(["other/keep.txt"]);
  });
});

describe("paths are checked whatever the backend", () => {
  it("refuses a stored path that could climb out of its folder", async () => {
    process.env.EVIDENCE_STORAGE = "blob";
    for (const bad of ["../secret.png", "act/../../x.png", "/abs.png", "act//x.png"]) {
      await expect(readStored(bad), bad).rejects.toMatchObject({ status: 400 });
    }
    expect(blob.get).not.toHaveBeenCalled();
  });
});
