import fs from "node:fs/promises";
import path from "node:path";
import { config } from "@/lib/config";
import { ApiError } from "@/lib/http/errors";
import type { StorageBackend } from "./storage-backend";

/**
 * Local disk under EVIDENCE_STORAGE_DIR, one folder per activation. The
 * backend for development, the test suite and any self-hosted server. A
 * Vercel function's filesystem does not persist, so the hosted app uses
 * storage-blob.ts instead.
 */
function root(): string {
  return path.resolve(process.cwd(), config().EVIDENCE_STORAGE_DIR);
}

function inside(storagePath: string): string {
  const absolute = path.resolve(root(), storagePath);
  if (!absolute.startsWith(root())) throw new ApiError(400, "bad_request", "Invalid evidence path.");
  return absolute;
}

export const diskBackend: StorageBackend = {
  name: "disk",

  async write(storagePath, bytes) {
    const absolute = inside(storagePath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, bytes);
  },

  async read(storagePath) {
    try {
      return await fs.readFile(inside(storagePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },

  async removeFolder(folder) {
    await fs.rm(inside(folder), { recursive: true, force: true });
  },

  async removeAll() {
    await fs.rm(root(), { recursive: true, force: true });
  },
};
