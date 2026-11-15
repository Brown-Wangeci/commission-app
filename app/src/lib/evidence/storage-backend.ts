/**
 * Where evidence bytes are kept. A storage path is always
 * "<activationId>/<storedName>", the same for every backend, and is what the
 * EvidenceItem row records, so changing backend needs no data migration.
 */
export type StorageBackend = {
  readonly name: "disk" | "blob";
  write(storagePath: string, bytes: Uint8Array, mimeType: string): Promise<void>;
  /** The bytes, or null when nothing is stored at that path. */
  read(storagePath: string): Promise<Buffer | null>;
  /** Removes everything under "<folder>/". Removing nothing is not an error. */
  removeFolder(folder: string): Promise<void>;
  /** Removes every evidence file. Only the seed calls this, after it has emptied the database. */
  removeAll(): Promise<void>;
};

export type BackendName = StorageBackend["name"];

/**
 * EVIDENCE_STORAGE if set; otherwise blob on Vercel (whose filesystem does not
 * persist between invocations) and disk everywhere else, so local development
 * and the test suite never touch object storage unless asked to.
 */
export function backendName(env: Record<string, string | undefined> = process.env): BackendName {
  const chosen = env.EVIDENCE_STORAGE;
  if (chosen === "disk" || chosen === "blob") return chosen;
  if (chosen) throw new Error(`EVIDENCE_STORAGE must be "disk" or "blob", not "${chosen}".`);
  return env.VERCEL === "1" ? "blob" : "disk";
}
