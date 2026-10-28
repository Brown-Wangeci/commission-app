import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { transitionActivation } from "@/lib/activations/transition";
import { acceptAssignment, assignJob, escrowBalance, fundJob, holdStateFor } from "@/lib/escrow/holds";
import { resetDatabase } from "./helpers/db";
import { createActivation, createAgent, createClient, createJob, createUser } from "./helpers/factories";

beforeEach(resetDatabase);

async function fundedJob(slots = 3, fundKsh = 900) {
  const client = await createClient();
  const job = await createJob(client.id, { slots, payoutPerActivationKsh: 300 });
  const clientUser = await prisma.clientBusiness.findUniqueOrThrow({ where: { id: client.id } });
  if (fundKsh > 0) await fundJob({ jobId: job.id, clientId: client.id, amountKsh: fundKsh, actorId: clientUser.userId });
  const admin = await createUser("admin");
  return { client, job, admin };
}

describe("escrow holds (issue #5)", () => {
  it("creates a hold with the job's payout when a job is assigned", async () => {
    const { job, admin } = await fundedJob();
    const agent = await createAgent();
    const assignment = await assignJob({ jobId: job.id, agentId: agent.id, assignedById: admin.id });
    expect(assignment.hold?.amountKsh).toBe(300);
    expect((await holdStateFor(prisma, assignment.id))?.state).toBe("reserved");
  });

  it("derives the hold state from the activation state with no second write", async () => {
    const { job, admin } = await fundedJob();
    const agent = await createAgent();
    const assignment = await assignJob({ jobId: job.id, agentId: agent.id, assignedById: admin.id });
    await acceptAssignment({ assignmentId: assignment.id, agentId: agent.id });
    const accepted = await prisma.assignment.findUniqueOrThrow({ where: { id: assignment.id } });
    const activation = await createActivation(accepted);
    const holdBefore = await prisma.escrowHold.findUniqueOrThrow({ where: { assignmentId: assignment.id } });

    expect((await holdStateFor(prisma, assignment.id))?.state).toBe("held");

    const steps = [
      ["submitted", "scored_t0", "held"],
      ["scored_t0", "held", "held"],
      ["held", "scored_t7", "held"],
      ["scored_t7", "refused", "returned"],
      ["refused", "disputed", "held"],
      ["disputed", "approved", "released"],
    ] as const;
    for (const [from, to, expected] of steps) {
      await prisma.$transaction((tx) => transitionActivation(tx, { activationId: activation.id, from, to }));
      expect((await holdStateFor(prisma, assignment.id))?.state, `${from} -> ${to}`).toBe(expected);
    }

    const holdAfter = await prisma.escrowHold.findUniqueOrThrow({ where: { assignmentId: assignment.id } });
    expect(holdAfter).toEqual(holdBefore);
  });

  it("refuses an assignment the escrow cannot cover", async () => {
    const { job, admin } = await fundedJob(3, 300);
    const first = await createAgent();
    const second = await createAgent();
    await assignJob({ jobId: job.id, agentId: first.id, assignedById: admin.id });
    await expect(assignJob({ jobId: job.id, agentId: second.id, assignedById: admin.id })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("refuses an assignment beyond the job's slots", async () => {
    const { job, admin } = await fundedJob(1, 900);
    const agent = await createAgent();
    await assignJob({ jobId: job.id, agentId: agent.id, assignedById: admin.id });
    await expect(assignJob({ jobId: job.id, agentId: agent.id, assignedById: admin.id })).rejects.toThrow(/slot/);
  });

  it("keeps concurrent assignments within the funded amount", async () => {
    const { job, admin } = await fundedJob(5, 600);
    const agents = await Promise.all([createAgent(), createAgent(), createAgent()]);
    const results = await Promise.allSettled(
      agents.map((agent) => assignJob({ jobId: job.id, agentId: agent.id, assignedById: admin.id })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const balance = await escrowBalance(prisma, job.id);
    expect(balance.availableKsh).toBe(0);
  });

  it("returns a refused activation's money to the available balance", async () => {
    const { job, admin } = await fundedJob(3, 900);
    const agent = await createAgent();
    const assignment = await assignJob({ jobId: job.id, agentId: agent.id, assignedById: admin.id });
    const activation = await createActivation(assignment);
    for (const [from, to] of [["submitted", "scored_t0"], ["scored_t0", "held"], ["held", "scored_t7"], ["scored_t7", "refused"]] as const) {
      await prisma.$transaction((tx) => transitionActivation(tx, { activationId: activation.id, from, to }));
    }
    const balance = await escrowBalance(prisma, job.id);
    expect(balance).toMatchObject({ fundedKsh: 900, returnedKsh: 300, availableKsh: 900 });
  });

  it("only lets the owning client fund a job", async () => {
    const { job } = await fundedJob(3, 0);
    const stranger = await createClient();
    await expect(
      fundJob({ jobId: job.id, clientId: stranger.id, amountKsh: 100, actorId: stranger.userId }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
