import { del, get, list, put } from "@vercel/blob";
import type { StorageBackend } from "./storage-backend";

/**
 * Vercel Blob, for the hosted app. The store must be created PRIVATE: a
 * private blob has no public URL and is read only with the store's token, so
 * a customer photo is still served only through the authorised
 * /api/evidence/[id] route, exactly as from disk.
 *
 * The SDK reads its credentials from the environment (BLOB_READ_WRITE_TOKEN,
 * or OIDC on Vercel); they are never passed, logged or stored here.
 */
const PREFIX = "evidence/";

function pathname(storagePath: string): string {
  return `${PREFIX}${storagePath}`;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

async function listPathnames(prefix: string): Promise<string[]> {
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor });
    found.push(...page.blobs.map((blob) => blob.pathname));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return found;
}

export const blobBackend: StorageBackend = {
  name: "blob",

  async write(storagePath, bytes, mimeType) {
    // Same path, same file: overwriting matches the disk backend.
    await put(pathname(storagePath), Buffer.from(bytes), {
      access: "private",
      contentType: mimeType,
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  },

  async read(storagePath) {
    // useCache: false, so a read straight after an overwrite sees the new file.
    const result = await get(pathname(storagePath), { access: "private", useCache: false });
    if (!result || result.statusCode !== 200) return null;
    return readAll(result.stream);
  },

  async removeFolder(folder) {
    const pathnames = await listPathnames(pathname(`${folder.replace(/\/$/, "")}/`));
    if (pathnames.length > 0) await del(pathnames);
  },

  async removeAll() {
    const pathnames = await listPathnames(PREFIX);
    if (pathnames.length > 0) await del(pathnames);
  },
};
