import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { resetDatabase } from "./helpers/db";
import { createActivation, createAgent, createClient, createJob, createScenario } from "./helpers/factories";

beforeEach(resetDatabase);

describe("schema (issue #1)", () => {
  it("creates the full chain client -> job -> assignment -> activation", async () => {
    const { assignment } = await createScenario();
    const activation = await createActivation(assignment);
    const loaded = await prisma.activation.findUniqueOrThrow({
      where: { id: activation.id },
      include: { job: { include: { client: true } }, agent: true, assignment: true },
    });
    expect(loaded.state).toBe("submitted");
    expect(loaded.job.client.id).toBeTruthy();
  });

  it("rejects an activation whose assignment does not exist", async () => {
    const { assignment } = await createScenario();
    await expect(
      createActivation({ ...assignment, id: "missing-assignment" }),
    ).rejects.toThrow();
  });

  it("rejects an activation whose agent differs from its assignment's agent", async () => {
    const { assignment } = await createScenario();
    const other = await createAgent();
    await expect(createActivation({ ...assignment, agentId: other.id })).rejects.toThrow();
  });

  it("allows only one activation per assignment", async () => {
    const { assignment } = await createScenario();
    await createActivation(assignment);
    await expect(createActivation(assignment)).rejects.toThrow();
  });

  it("enforces check constraints on money and coordinates", async () => {
    const client = await createClient();
    await expect(createJob(client.id, { payoutPerActivationKsh: 0 })).rejects.toThrow();
    await expect(createJob(client.id, { commissionRate: 1.5 })).rejects.toThrow();
    await expect(createJob(client.id, { areaLat: 120 })).rejects.toThrow();
  });

  it("refuses a SIM registered after the submission", async () => {
    const { assignment } = await createScenario();
    await expect(
      createActivation(assignment, { simRegisteredAt: new Date("2030-01-01T00:00:00Z") }),
    ).rejects.toThrow();
  });
});
