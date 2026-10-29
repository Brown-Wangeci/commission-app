import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configVersion } from "@/lib/evidence/config";
import { submittedFields } from "@/lib/evidence/view";
import { databaseBefore, type MigrationDb } from "./helpers/migration-db";

/**
 * Issue #46: the evidence-configuration migration converts existing data.
 * Before it, every job asked for the same evidence (one to twelve photos plus
 * the platform's fields). Builds a database just before the migration, writes
 * a job, two activations with photos, proof and a reply to an evidence
 * request in that shape, migrates, and checks each record.
 */
const NEW_MIGRATION = "20261029120000_evidence_configuration";

let scratch: MigrationDb;
let db: PrismaClient;

async function exec(sql: string): Promise<void> {
  await db.$executeRawUnsafe(sql);
}

async function activation(id: string, assignment: string): Promise<void> {
  await exec(`INSERT INTO "Activation" (id, reference, "assignmentId", "agentId", "jobId", "submittedAt", "deviceId", "deviceOs", "appVersion",
    "ipRegion", "networkType", "gpsLat", "gpsLon", "customerMsisdnHash", "customerMsisdnMasked", "simRegisteredAt", "activationMethod", "updatedAt")
    VALUES ('${id}', 'LF-${id}', '${assignment}', 'agent1', 'job1', '2026-10-01 08:00', 'dev', 'android', '3.4.0',
    'region_a', 'cellular', -1.28, 36.83, 'hash-${id}', '07** *** 000', '2026-09-01', 'qr_scan', '2026-10-01 08:00')`);
}

async function evidence(id: string, activationId: string, kind: "photo" | "proof", sequence: number, requestId: string | null = null): Promise<void> {
  await exec(`INSERT INTO "EvidenceItem" (id, "activationId", "evidenceRequestId", kind, sequence, "fileName", "mimeType", "storagePath", sha256, "capturedAt", "gpsLat", "gpsLon", "gpsAccuracyM", "locationSource")
    VALUES ('${id}', '${activationId}', ${requestId ? `'${requestId}'` : "NULL"}, '${kind}', ${sequence}, 'f.png', 'image/png', 'x/f.png', 'abc',
    ${kind === "photo" ? "'2026-10-01 07:50', -1.2801, 36.8302, 6, 'device'" : "NULL, NULL, NULL, NULL, 'none'"})`);
}

beforeAll(async () => {
  scratch = await databaseBefore(NEW_MIGRATION, "evidence");
  db = scratch.db;
  await exec(`INSERT INTO "User" (id, email, name, "passwordHash", role) VALUES
    ('owner', 'owner@x.test', 'Owner', 'x', 'client'), ('agentuser', 'agent@x.test', 'Agent', 'x', 'agent'), ('admin', 'admin@x.test', 'Admin', 'x', 'admin')`);
  await exec(`INSERT INTO "ClientBusiness" (id, "userId", name) VALUES ('client1', 'owner', 'Client')`);
  await exec(`INSERT INTO "Agent" (id, "userId", "payoutMsisdn", "registeredAt", "homeLat", "homeLon", "homeAreaName") VALUES ('agent1', 'agentuser', '0712000000', '2025-01-01', -1.29, 36.82, 'CBD')`);
  await exec(`INSERT INTO "Job" (id, "clientId", title, description, "areaName", "areaLat", "areaLon", "areaRadiusM", "submissionValueCents", "commissionRateBps", "flatCommissionCents", slots, "escrowLockedCents", "createdAt")
    VALUES ('job1', 'client1', 'Old job', 'Before configuration', 'Area', -1.28, 36.83, 700, 300000, 1000, 0, 3, 0, '2026-06-01')`);
  await exec(`INSERT INTO "Assignment" (id, "jobId", "agentId", "assignedById", "assignedAt", "acceptedAt") VALUES
    ('as1', 'job1', 'agent1', 'admin', '2026-10-01 06:00', '2026-10-01 07:00'), ('as2', 'job1', 'agent1', 'admin', '2026-10-01 06:00', '2026-10-01 07:00')`);
  await activation("act1", "as1");
  await activation("act2", "as2");
  await exec(`INSERT INTO "EvidenceRequest" (id, "activationId", "requestedById", "requestedAt", message, status) VALUES ('req1', 'act2', 'admin', '2026-10-02 09:00', 'More please', 'answered')`);
  await evidence("e1", "act1", "photo", 1);
  await evidence("e2", "act1", "photo", 2);
  await evidence("e3", "act1", "photo", 3);
  await evidence("e4", "act1", "proof", 4);
  await evidence("e5", "act2", "photo", 1);
  await evidence("e6", "act2", "photo", 2, "req1");
  scratch.migrate();
}, 180_000);

afterAll(async () => {
  await scratch?.drop();
});

describe("evidence-configuration migration on existing data (issue #46)", () => {
  it("gives each existing job version 1 of a configuration holding the evidence it always asked for", async () => {
    const [config] = await db.evidenceConfig.findMany({ where: { jobId: "job1" } });
    expect(config).toMatchObject({ version: 1 });
    expect(configVersion(config).fields).toEqual([
      { key: "field_1", label: "Photos", type: "photo", mandatory: true, help: "Photos of the activation, as every job asked for before evidence fields could be configured.", format: { minCount: 1, maxCount: 12 } },
    ]);
  });

  it("links every existing activation to it and lists its submitted photos under the field", async () => {
    const rows = await db.activation.findMany({ orderBy: { id: "asc" }, include: { evidenceConfig: true } });
    expect(rows.map((a) => [a.id, a.evidenceConfig.version, a.evidencePayload])).toEqual([
      ["act1", 1, { field_1: [1, 2, 3] }],
      ["act2", 1, { field_1: [1] }],
    ]);
    expect(submittedFields(configVersion(rows[0].evidenceConfig), rows[0].evidencePayload)).toMatchObject([{ label: "Photos", photoSequences: [1, 2, 3] }]);
  });

  it("files each photo under its field, proof under proof, and a reply under no field", async () => {
    const items = await db.evidenceItem.findMany({ orderBy: { id: "asc" } });
    expect(items.map((e) => [e.id, e.fieldKey])).toEqual([["e1", "field_1"], ["e2", "field_1"], ["e3", "field_1"], ["e4", "proof"], ["e5", "field_1"], ["e6", null]]);
  });

  it("leaves existing jobs without a deadline, and the new columns required from now on", async () => {
    expect((await db.job.findUniqueOrThrow({ where: { id: "job1" } })).deadlineAt).toBeNull();
    const columns = await db.$queryRaw<{ column_name: string; is_nullable: string }[]>`
      SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'Activation' AND column_name IN ('evidenceConfigId', 'evidencePayload')`;
    expect(columns.map((c) => c.is_nullable)).toEqual(["NO", "NO"]);
  });
});
