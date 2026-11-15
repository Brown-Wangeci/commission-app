import { createHash } from "node:crypto";
import path from "node:path";
import { config } from "@/lib/config";
import { ApiError } from "@/lib/http/errors";
import { backendName, type StorageBackend } from "./storage-backend";
import { blobBackend } from "./storage-blob";
import { diskBackend } from "./storage-disk";

/**
 * Evidence files, one folder per activation, served only through the
 * authorised /api/evidence/[id] route. This module is the storage boundary:
 * nothing else reads or writes evidence bytes. Where they live is chosen by
 * storage-backend.ts: local disk under EVIDENCE_STORAGE_DIR for development
 * and tests, a private Vercel Blob store for the hosted app.
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

function backend(): StorageBackend {
  return backendName() === "blob" ? blobBackend : diskBackend;
}

/** A stored path is "<activationId>/<name>"; anything that could climb out is refused. */
function checkedPath(storagePath: string): string {
  const normal = path.posix.normalize(storagePath);
  if (normal !== storagePath || normal.startsWith("/") || normal.split("/").includes("..")) {
    throw new ApiError(400, "bad_request", "Invalid evidence path.");
  }
  return normal;
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
  const storagePath = checkedPath(path.posix.join(activationId, storedName));
  await backend().write(storagePath, bytes, mimeType);
  return { storagePath, sha256: sha256(bytes), mimeType, fileName: originalName.slice(0, 200) };
}

export async function readStored(storagePath: string): Promise<Buffer> {
  const bytes = await backend().read(checkedPath(storagePath));
  if (!bytes) throw new ApiError(404, "not_found", "The evidence file is missing from storage.");
  return bytes;
}

export async function removeActivationFiles(activationId: string): Promise<void> {
  await backend().removeFolder(checkedPath(activationId));
}

/** Empties evidence storage, whichever backend is in use. For the seed only. */
export async function removeAllEvidence(): Promise<void> {
  await backend().removeAll();
}

/** Which backend is in use, for the seed log. Never a credential. */
export function evidenceBackendName(): StorageBackend["name"] {
  return backend().name;
}
