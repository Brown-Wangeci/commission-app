import type { EvidenceConfig, Prisma } from "@prisma/client";
import { prisma, type Tx } from "@/lib/db";
import { ApiError, conflict, notFound } from "@/lib/http/errors";
import { recordAuditEvent } from "@/lib/activations/transition";
import { lockJob } from "@/lib/escrow/holds";
import { evidenceConfigInputSchema, storedConfigSchema, withKeys, type FieldDefinition, type FieldInput } from "./fields";

/**
 * Versions of a job's evidence configuration (FR-05, DR-06, issue #46).
 * The current version is the highest; a submission is validated against the
 * current version and keeps its id, and versions are never changed or
 * deleted (a database trigger enforces it), so editing a job's fields never
 * changes what a past submission was judged against.
 */
export type ConfigVersion = { id: string; jobId: string; version: number; createdAt: Date; fields: FieldDefinition[] };

export function configVersion(row: EvidenceConfig): ConfigVersion {
  return { id: row.id, jobId: row.jobId, version: row.version, createdAt: row.createdAt, fields: storedConfigSchema.parse(row.fields) as FieldDefinition[] };
}

export async function currentEvidenceConfig(db: Tx, jobId: string): Promise<ConfigVersion> {
  const row = await db.evidenceConfig.findFirst({ where: { jobId }, orderBy: { version: "desc" } });
  if (!row) throw new Error(`Job ${jobId} has no evidence configuration.`);
  return configVersion(row);
}

export async function evidenceConfigById(db: Tx, id: string): Promise<ConfigVersion> {
  return configVersion(await db.evidenceConfig.findUniqueOrThrow({ where: { id } }));
}

/** The client's fields, validated; a 422 naming each problem by field position. */
export function parseEvidenceFields(input: unknown): ReturnType<typeof evidenceConfigInputSchema.parse> {
  const parsed = evidenceConfigInputSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const details = parsed.error.issues.map((issue) => ({ path: ["evidenceFields", ...issue.path].join("."), message: issue.message }));
  throw new ApiError(422, "validation_failed", `The evidence fields are not valid: ${details[0].message}`, details);
}

/** Writes the next version of a job's configuration inside an existing transaction. */
export async function addConfigVersion(
  tx: Prisma.TransactionClient,
  input: { jobId: string; fields: FieldInput[]; actorId: string | null; at?: Date },
): Promise<ConfigVersion> {
  const latest = await tx.evidenceConfig.findFirst({ where: { jobId: input.jobId }, orderBy: { version: "desc" } });
  const previous = latest ? configVersion(latest).fields : [];
  const fields = withKeys(parseEvidenceFields(input.fields), previous);
  const row = await tx.evidenceConfig.create({
    data: {
      jobId: input.jobId,
      version: (latest?.version ?? 0) + 1,
      fields: fields as unknown as Prisma.InputJsonValue,
      createdById: input.actorId,
      createdAt: input.at,
    },
  });
  return configVersion(row);
}

/**
 * The client edits a job's evidence fields: a new version, effective for
 * every submission from now on. Earlier submissions keep their version.
 */
export async function updateEvidenceConfig(input: { jobId: string; clientId: string; actorId: string; fields: unknown; at?: Date }): Promise<ConfigVersion> {
  return prisma.$transaction(async (tx) => {
    await lockJob(tx, input.jobId);
    const job = await tx.job.findUniqueOrThrow({ where: { id: input.jobId } });
    if (job.clientId !== input.clientId) throw notFound("Job");
    if (job.status !== "open") throw conflict("This job is closed; its evidence fields can no longer change.");
    const created = await addConfigVersion(tx, { jobId: job.id, fields: input.fields as FieldInput[], actorId: input.actorId, at: input.at });
    await recordAuditEvent(tx, {
      kind: "evidence_config_changed",
      actorId: input.actorId,
      detail: `Job "${job.title}" evidence fields changed to version ${created.version} (${created.fields.length} field(s)); earlier submissions keep the version they were made under.`,
      at: input.at,
    });
    return created;
  });
}

/** Every version of a job's configuration, newest first, without the fields. */
export async function configHistory(db: Tx, jobId: string) {
  const rows = await db.evidenceConfig.findMany({ where: { jobId }, orderBy: { version: "desc" }, include: { _count: { select: { activations: true } } } });
  return rows.map((row) => ({ id: row.id, version: row.version, createdAt: row.createdAt, fieldCount: (row.fields as unknown[]).length, submissions: row._count.activations }));
}
