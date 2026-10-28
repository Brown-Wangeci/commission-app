import type { Activation, Agent, Assignment, ClientBusiness, Job, User } from "@prisma/client";
import { prisma } from "@/lib/db";

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

export async function createJob(clientId: string, overrides: Partial<Job> = {}): Promise<Job> {
  return prisma.job.create({
    data: {
      clientId,
      title: `Job ${next()}`,
      description: "Sign up customers",
      areaName: "Gikomba market",
      areaLat: -1.2833,
      areaLon: 36.8333,
      areaRadiusM: 1500,
      payoutPerActivationKsh: 300,
      commissionRate: 0.1,
      slots: 10,
      ...overrides,
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
  overrides: Partial<Activation> = {},
): Promise<Activation> {
  const n = next();
  return prisma.activation.create({
    data: {
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
