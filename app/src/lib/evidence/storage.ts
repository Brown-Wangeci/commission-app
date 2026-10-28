import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "@/lib/config";
import { ApiError } from "@/lib/http/errors";

/**
 * Evidence files live on local disk under EVIDENCE_STORAGE_DIR, one folder
 * per activation, and are served only through the authorised
 * /api/evidence/[id] route. A hosted deployment would swap this module for
 * object storage; nothing else reads the disk directly.
 */
export const UPLOAD_TYPES: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};

export type StoredFile = { storagePath: string; sha256: string; mimeType: string; fileName: string };

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function root(): string {
  return path.resolve(process.cwd(), config().EVIDENCE_STORAGE_DIR);
}

function checkUpload(file: File): string {
  const extension = UPLOAD_TYPES[file.type];
  if (!extension) {
    throw new ApiError(415, "unsupported_media_type", `${file.name}: only JPEG, PNG, WebP or HEIC photos are accepted.`);
  }
  if (file.size > config().EVIDENCE_MAX_BYTES) {
    throw new ApiError(413, "payload_too_large", `${file.name} is larger than the ${config().EVIDENCE_MAX_BYTES} byte limit.`);
  }
  if (file.size === 0) throw new ApiError(400, "bad_request", `${file.name} is empty.`);
  return extension;
}

/** Validates and writes one uploaded file. Returns where it went and its hash. */
export async function storeUpload(activationId: string, label: string, file: File): Promise<StoredFile> {
  const extension = checkUpload(file);
  const bytes = new Uint8Array(await file.arrayBuffer());
  return storeBytes(activationId, `${label}.${extension}`, bytes, file.type, file.name);
}

export async function storeBytes(
  activationId: string,
  storedName: string,
  bytes: Uint8Array,
  mimeType: string,
  originalName: string,
): Promise<StoredFile> {
  const relative = path.posix.join(activationId, storedName);
  const absolute = path.join(root(), activationId, storedName);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, bytes);
  return { storagePath: relative, sha256: sha256(bytes), mimeType, fileName: originalName.slice(0, 200) };
}

export async function readStored(storagePath: string): Promise<Buffer> {
  const absolute = path.resolve(root(), storagePath);
  if (!absolute.startsWith(root())) throw new ApiError(400, "bad_request", "Invalid evidence path.");
  try {
    return await fs.readFile(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ApiError(404, "not_found", "The evidence file is missing from storage.");
    throw error;
  }
}

export async function removeActivationFiles(activationId: string): Promise<void> {
  await fs.rm(path.join(root(), activationId), { recursive: true, force: true });
}
