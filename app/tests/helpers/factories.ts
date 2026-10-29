import type { Activation, Agent, Assignment, ClientBusiness, Job, Prisma, User } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { FieldDefinition } from "@/lib/evidence/fields";
import { maxLiability } from "@/lib/money/commission";

let counter = 0;
function next(): number {
  counter += 1;
  return counter;
}

export async function createUser(role: "agent" | "admin" | "client", name?: string): Promise<User> {
  const n = next();
  return prisma.user.create({
    data: {
      email: `${role}${n}@test.local`,
      name: name ?? `Test ${role} ${n}`,
      passwordHash: "not-a-real-hash",
      role,
    },
  });
}

export async function createClient(): Promise<ClientBusiness> {
  const user = await createUser("client");
  return prisma.clientBusiness.create({ data: { userId: user.id, name: `Business ${next()}` } });
}

export async function createAgent(overrides: Partial<Agent> = {}): Promise<Agent> {
  const user = await createUser("agent");
  return prisma.agent.create({
    data: {
      userId: user.id,
      payoutMsisdn: "0712000000",
      registeredAt: new Date("2025-01-10T06:00:00Z"),
      homeLat: -1.2921,
      homeLon: 36.8219,
      homeAreaName: "Nairobi CBD",
      ...overrides,
    },
  });
}

/** KSh 3,000.00 x 10.00% = KSh 300.00 per approved submission. */
export const TEST_TERMS = { submissionValueCents: 300_000, commissionRateBps: 1000, flatCommissionCents: 0 } as const;

/** The test job's evidence fields: one mandatory photo field, as every job asked for before configuration existed. */
export const TEST_EVIDENCE_FIELDS: FieldDefinition[] = [
  { key: "field_1", label: "Photos of the activation", type: "photo", mandatory: true, help: null, format: { minCount: 1, maxCount: 12 } },
];

/**
 * A job row written directly, bypassing publication: its lock defaults to the
 * full liability, but no deposit backs it. Tests of publication and the
 * client balance use createJob from src/lib/jobs/jobs.ts instead
 * (helpers/submission.ts publishFundedJob).
 */
export async function createJob(clientId: string, overrides: Partial<Job> = {}): Promise<Job> {
  const terms = { ...TEST_TERMS, slots: 10, ...overrides };
  return prisma.job.create({
    data: {
      clientId,
      title: `Job ${next()}`,
      description: "Sign up customers",
      areaName: "Gikomba market",
      areaLat: -1.2833,
      areaLon: 36.8333,
      areaRadiusM: 1500,
      escrowLockedCents: overrides.escrowLockedCents ?? maxLiability(terms, terms.slots).amountCents,
      ...terms,
      evidenceConfigs: { create: { version: 1, fields: TEST_EVIDENCE_FIELDS as unknown as Prisma.InputJsonValue } },
    },
  });
}

export async function createAssignment(
  jobId: string,
  agentId: string,
  assignedAt = new Date("2026-10-01T05:00:00Z"),
): Promise<Assignment> {
  const admin = await createUser("admin");
  return prisma.assignment.create({
    data: {
      jobId,
      agentId,
      assignedById: admin.id,
      assignedAt,
      acceptedAt: new Date(assignedAt.getTime() + 30 * 60 * 1000),
    },
  });
}

export async function createActivation(
  assignment: Assignment,
  overrides: Partial<Omit<Activation, "evidencePayload">> = {},
): Promise<Activation> {
  const n = next();
  const config = await prisma.evidenceConfig.findFirstOrThrow({ where: { jobId: assignment.jobId }, orderBy: { version: "desc" } });
  return prisma.activation.create({
    data: {
      evidenceConfigId: config.id,
      evidencePayload: {},
      reference: `LF-T${String(n).padStart(5, "0")}`,
      assignmentId: assignment.id,
      agentId: assignment.agentId,
      jobId: assignment.jobId,
      submittedAt: new Date((assignment.acceptedAt ?? assignment.assignedAt).getTime() + 60 * 60 * 1000),
      deviceId: `device-${n}`,
      deviceOs: "android",
      appVersion: "3.4.0",
      ipRegion: "region_a",
      networkType: "cellular",
      gpsLat: -1.2835,
      gpsLon: 36.8331,
      gpsAccuracyM: 8,
      customerMsisdnHash: `hash-${n}`,
      customerMsisdnMasked: "07** *** 123",
      simRegisteredAt: new Date("2026-09-01T00:00:00Z"),
      activationMethod: "qr_scan",
      ...overrides,
    },
  });
}

/** A client, agent, job and accepted assignment, ready for an activation. */
export async function createScenario(): Promise<{
  client: ClientBusiness;
  agent: Agent;
  job: Job;
  assignment: Assignment;
}> {
  const client = await createClient();
  const agent = await createAgent();
  const job = await createJob(client.id);
  const assignment = await createAssignment(job.id, agent.id);
  return { client, agent, job, assignment };
}
