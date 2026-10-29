import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { transitionActivation } from "@/lib/activations/transition";
import { clientEscrow, fundEscrow } from "@/lib/escrow/client";
import { acceptAssignment, assignJob, holdStateFor, jobEscrow } from "@/lib/escrow/holds";
import { closeJob, createJob } from "@/lib/jobs/jobs";
import { resetDatabase } from "./helpers/db";
import { createActivation, createAgent, createClient, createUser } from "./helpers/factories";
import { jobInput, publishFundedJob } from "./helpers/submission";

beforeEach(resetDatabase);

/** KSh 300.00 per approved submission (helpers TEST_TERMS). */
const COMMISSION = 30_000;

type Step = readonly [Parameters<typeof transitionActivation>[1]["from"], Parameters<typeof transitionActivation>[1]["to"]];

async function walk(activationId: string, steps: readonly Step[]): Promise<void> {
  for (const [from, to] of steps) {
    await prisma.$transaction((tx) => transitionActivation(tx, { activationId, from, to }));
  }
}

const TO_HELD: Step[] = [["submitted", "scored_t0"], ["scored_t0", "held"]];
const TO_REFUSED: Step[] = [...TO_HELD, ["held", "scored_t7"], ["scored_t7", "refused"]];
const TO_APPROVED: Step[] = [...TO_HELD, ["held", "scored_t7"], ["scored_t7", "approved"]];

async function assigned(jobId: string) {
  const admin = await createUser("admin");
  const agent = await createAgent();
  const assignment = await assignJob({ jobId, agentId: agent.id, assignedById: admin.id });
  await acceptAssignment({ assignmentId: assignment.id, agentId: agent.id });
  return prisma.assignment.findUniqueOrThrow({ where: { id: assignment.id } });
}

describe("escrow holds (issue #5)", () => {
  it("reserves one commission from the job's lock when a job is assigned", async () => {
    const { job } = await publishFundedJob({ slots: 3 });
    const admin = await createUser("admin");
    const agent = await createAgent();
    const assignment = await assignJob({ jobId: job.id, agentId: agent.id, assignedById: admin.id });
    expect(assignment.hold?.amountCents).toBe(COMMISSION);
    expect((await holdStateFor(prisma, assignment.id))?.state).toBe("reserved");
  });

  it("derives the hold state from the activation state with no second write", async () => {
    const { job } = await publishFundedJob({ slots: 3 });
    const assignment = await assigned(job.id);
    const activation = await createActivation(assignment);
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

  it("refuses an assignment beyond the job's slots", async () => {
    const { job } = await publishFundedJob({ slots: 1 });
    await assigned(job.id);
    await expect(assigned(job.id)).rejects.toThrow(/slot/);
  });

  it("keeps concurrent assignments within the job's lock and slots", async () => {
    const { job } = await publishFundedJob({ slots: 2 });
    const admin = await createUser("admin");
    const agents = await Promise.all([createAgent(), createAgent(), createAgent()]);
    const results = await Promise.allSettled(
      agents.map((agent) => assignJob({ jobId: job.id, agentId: agent.id, assignedById: admin.id })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(await jobEscrow(prisma, job)).toMatchObject({ lockedCents: 2 * COMMISSION, reservedCents: 2 * COMMISSION, unspentCents: 0 });
  });

  it("returns a refused activation's money to the job's unspent amount", async () => {
    const { job } = await publishFundedJob({ slots: 3 });
    const activation = await createActivation(await assigned(job.id));
    await walk(activation.id, TO_REFUSED);
    expect(await jobEscrow(prisma, job)).toMatchObject({ lockedCents: 3 * COMMISSION, returnedCents: COMMISSION, unspentCents: 3 * COMMISSION });
  });

  it("only lets a client fund its own escrow, in whole cents", async () => {
    const client = await createClient();
    await expect(fundEscrow({ clientId: "missing", amountCents: 100, actorId: client.userId })).rejects.toMatchObject({ status: 404 });
    await expect(fundEscrow({ clientId: client.id, amountCents: 100.5, actorId: client.userId })).rejects.toThrow(/whole number of cents/);
    await expect(fundEscrow({ clientId: client.id, amountCents: -1, actorId: client.userId })).rejects.toThrow(/whole number of cents/);
  });
});

describe("escrow locked at publication (FR-07, issue #42)", () => {
  it("refuses publication when the available balance does not cover the maximum liability, and writes nothing", async () => {
    const client = await createClient();
    // 10 slots x KSh 300.00 = KSh 3,000.00 needed; one cent short.
    await fundEscrow({ clientId: client.id, amountCents: 10 * COMMISSION - 1, actorId: client.userId });
    const refused = createJob({ clientId: client.id, actorId: client.userId, job: jobInput({ slots: 10 }) });
    await expect(refused).rejects.toMatchObject({
      status: 409,
      details: { availableCents: 10 * COMMISSION - 1, neededCents: 10 * COMMISSION, shortfallCents: 1, neededDerivation: "10 × KSh 300.00 per approved submission" },
    });
    expect(await prisma.job.count()).toBe(0);
    expect(await clientEscrow(prisma, client.id)).toMatchObject({ depositedCents: 10 * COMMISSION - 1, committedCents: 0, availableCents: 10 * COMMISSION - 1 });
  });

  it("publishes when the balance covers the liability exactly, locking all of it", async () => {
    const client = await createClient();
    await fundEscrow({ clientId: client.id, amountCents: 10 * COMMISSION, actorId: client.userId });
    const job = await createJob({ clientId: client.id, actorId: client.userId, job: jobInput({ slots: 10 }) });
    expect(job.escrowLockedCents).toBe(10 * COMMISSION);
    expect(await clientEscrow(prisma, client.id)).toMatchObject({ depositedCents: 10 * COMMISSION, committedCents: 10 * COMMISSION, availableCents: 0 });
  });

  it("rolls back a deposit made with a publication that is still refused", async () => {
    const client = await createClient();
    const refused = createJob({ clientId: client.id, actorId: client.userId, job: jobInput({ slots: 10, initialDepositCents: 9 * COMMISSION }) });
    await expect(refused).rejects.toMatchObject({ status: 409 });
    expect(await prisma.escrowDeposit.count()).toBe(0);
    expect(await prisma.job.count()).toBe(0);
  });

  it("counts every open job's lock against the balance", async () => {
    const { client } = await publishFundedJob({ slots: 5 });
    await expect(createJob({ clientId: client.id, actorId: client.userId, job: jobInput({ slots: 1 }) })).rejects.toMatchObject({ status: 409 });
    await fundEscrow({ clientId: client.id, amountCents: COMMISSION, actorId: client.userId });
    await createJob({ clientId: client.id, actorId: client.userId, job: jobInput({ slots: 1 }) });
    expect((await clientEscrow(prisma, client.id)).availableCents).toBe(0);
  });

  it("lets only one of two concurrent publications spend the same balance", async () => {
    const client = await createClient();
    await fundEscrow({ clientId: client.id, amountCents: 10 * COMMISSION, actorId: client.userId });
    const results = await Promise.allSettled(
      [1, 2].map(() => createJob({ clientId: client.id, actorId: client.userId, job: jobInput({ slots: 10 }) })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await clientEscrow(prisma, client.id)).availableCents).toBe(0);
  });

  it("fixes a published job's terms and lock in the database", async () => {
    const { job } = await publishFundedJob({ slots: 3 });
    await expect(prisma.job.update({ where: { id: job.id }, data: { commissionRateBps: 2000 } })).rejects.toThrow(/cannot change/);
    await expect(prisma.job.update({ where: { id: job.id }, data: { slots: 30 } })).rejects.toThrow(/cannot change/);
    await expect(prisma.job.update({ where: { id: job.id }, data: { escrowLockedCents: 0 } })).rejects.toThrow(/cannot change/);
  });
});

describe("unspent remainder released at close (FR-20, issue #42)", () => {
  it("returns the lock less everything reserved, held or released, and keeps in-progress money committed", async () => {
    // 5 slots x KSh 300.00 = KSh 1,500.00 locked; one approved, one refused, one held, one reserved.
    const { client, job } = await publishFundedJob({ slots: 5 }, { extraDepositCents: 7_00 });
    await walk((await createActivation(await assigned(job.id))).id, TO_APPROVED);
    await walk((await createActivation(await assigned(job.id))).id, TO_REFUSED);
    const held = await createActivation(await assigned(job.id));
    await walk(held.id, TO_HELD);
    await assigned(job.id);

    expect(await clientEscrow(prisma, client.id)).toMatchObject({ depositedCents: 5 * COMMISSION + 7_00, committedCents: 5 * COMMISSION, availableCents: 7_00 });

    const closing = await closeJob({ jobId: job.id, clientId: client.id, actorId: client.userId });
    // KSh 1,500.00 locked - KSh 600.00 in progress (held + reserved) - KSh 300.00 released = KSh 600.00 back.
    expect(closing.returnedCents).toBe(2 * COMMISSION);
    expect(closing.returnedDerivation).toBe("KSh 1,500.00 locked − KSh 600.00 in progress − KSh 300.00 released");
    expect(await clientEscrow(prisma, client.id)).toMatchObject({ committedCents: 3 * COMMISSION, availableCents: 2 * COMMISSION + 7_00 });

    // The held activation is refused after close: its money comes back too.
    await walk(held.id, [["held", "scored_t7"], ["scored_t7", "refused"]]);
    expect(await clientEscrow(prisma, client.id)).toMatchObject({ committedCents: 2 * COMMISSION, availableCents: 3 * COMMISSION + 7_00 });
    expect(await prisma.auditEvent.count({ where: { kind: "job_closed" } })).toBe(1);
  });

  it("returns the whole lock when nothing was assigned", async () => {
    const { client, job } = await publishFundedJob({ slots: 4 });
    const closing = await closeJob({ jobId: job.id, clientId: client.id, actorId: client.userId });
    expect(closing.returnedCents).toBe(4 * COMMISSION);
    expect(await clientEscrow(prisma, client.id)).toMatchObject({ committedCents: 0, availableCents: 4 * COMMISSION });
  });

  it("refuses new assignments, a second close, another client's close, and reopening", async () => {
    const { client, job } = await publishFundedJob({ slots: 2 });
    const stranger = await createClient();
    await expect(closeJob({ jobId: job.id, clientId: stranger.id, actorId: stranger.userId })).rejects.toMatchObject({ status: 404 });
    await closeJob({ jobId: job.id, clientId: client.id, actorId: client.userId });
    await expect(assigned(job.id)).rejects.toThrow(/closed/);
    await expect(closeJob({ jobId: job.id, clientId: client.id, actorId: client.userId })).rejects.toMatchObject({ status: 409 });
    await expect(prisma.job.update({ where: { id: job.id }, data: { status: "open", closedAt: null } })).rejects.toThrow(/cannot be reopened/);
  });

  it("lets the returned money fund the client's next job", async () => {
    const { client, job } = await publishFundedJob({ slots: 3 });
    await closeJob({ jobId: job.id, clientId: client.id, actorId: client.userId });
    const next = await createJob({ clientId: client.id, actorId: client.userId, job: jobInput({ slots: 3 }) });
    expect(next.escrowLockedCents).toBe(3 * COMMISSION);
    expect((await clientEscrow(prisma, client.id)).availableCents).toBe(0);
  });
});
