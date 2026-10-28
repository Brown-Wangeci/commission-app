import type { EscrowHoldState, Prisma } from "@prisma/client";
import { prisma, type Tx } from "@/lib/db";
import { badRequest, conflict, notFound } from "@/lib/http/errors";
import { recordAuditEvent } from "@/lib/activations/transition";

/** Hold states as the EscrowHoldState view reports them. */
export type HoldState = "reserved" | "held" | "released" | "returned";

export type EscrowBalance = {
  fundedKsh: number;
  reservedKsh: number;
  heldKsh: number;
  releasedKsh: number;
  returnedKsh: number;
  /** Funded money not committed to any reserved, held or released hold. */
  availableKsh: number;
};

export async function holdStateFor(db: Tx, assignmentId: string): Promise<EscrowHoldState | null> {
  return db.escrowHoldState.findUnique({ where: { assignmentId } });
}

function sumBy(holds: EscrowHoldState[], state: HoldState): number {
  return holds.filter((hold) => hold.state === state).reduce((total, hold) => total + hold.amountKsh, 0);
}

export async function escrowBalance(db: Tx, jobId: string): Promise<EscrowBalance> {
  const [deposits, holds] = await Promise.all([
    db.escrowDeposit.aggregate({ where: { jobId }, _sum: { amountKsh: true } }),
    db.escrowHoldState.findMany({ where: { jobId } }),
  ]);
  const fundedKsh = deposits._sum.amountKsh ?? 0;
  const reservedKsh = sumBy(holds, "reserved");
  const heldKsh = sumBy(holds, "held");
  const releasedKsh = sumBy(holds, "released");
  return {
    fundedKsh,
    reservedKsh,
    heldKsh,
    releasedKsh,
    returnedKsh: sumBy(holds, "returned"),
    availableKsh: fundedKsh - reservedKsh - heldKsh - releasedKsh,
  };
}

/** Serialises escrow changes on one job, so two assignments cannot overspend it. */
async function lockJob(tx: Prisma.TransactionClient, jobId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Job" WHERE id = ${jobId} FOR UPDATE`;
  if (rows.length === 0) throw notFound("Job");
}

export type AssignInput = { jobId: string; agentId: string; assignedById: string; at?: Date };

/**
 * Assigns one slot of a job to an agent and locks one payout's worth of the
 * job's escrow in a hold, in a single transaction. Fails if the job is
 * closed, out of slots, or not funded enough.
 */
export async function assignJob(input: AssignInput) {
  const at = input.at ?? new Date();
  return prisma.$transaction(async (tx) => {
    await lockJob(tx, input.jobId);
    const job = await tx.job.findUniqueOrThrow({ where: { id: input.jobId } });
    if (job.status !== "open") throw conflict("This job is closed.");
    const agent = await tx.agent.findUnique({ where: { id: input.agentId } });
    if (!agent) throw notFound("Agent");
    const used = await tx.assignment.count({ where: { jobId: job.id } });
    if (used >= job.slots) throw conflict("Every slot on this job is already assigned.");
    const balance = await escrowBalance(tx, job.id);
    if (balance.availableKsh < job.payoutPerActivationKsh) {
      throw conflict("The job's escrow does not cover another payout. The client must fund it first.", {
        availableKsh: balance.availableKsh,
        neededKsh: job.payoutPerActivationKsh,
      });
    }
    const assignment = await tx.assignment.create({
      data: {
        jobId: job.id,
        agentId: agent.id,
        assignedById: input.assignedById,
        assignedAt: at,
        hold: { create: { amountKsh: job.payoutPerActivationKsh, createdAt: at } },
      },
      include: { hold: true },
    });
    await recordAuditEvent(tx, {
      kind: "job_assigned",
      actorId: input.assignedById,
      detail: `Job "${job.title}" assigned to agent ${agent.id}; KSh ${job.payoutPerActivationKsh} locked in escrow.`,
      at,
    });
    return assignment;
  });
}

/** The agent accepts an assignment. Acceptance time feeds the scoring model. */
export async function acceptAssignment(input: { assignmentId: string; agentId: string; at?: Date }) {
  const at = input.at ?? new Date();
  return prisma.$transaction(async (tx) => {
    const assignment = await tx.assignment.findUnique({ where: { id: input.assignmentId } });
    if (!assignment || assignment.agentId !== input.agentId) throw notFound("Assignment");
    if (assignment.acceptedAt) throw conflict("You have already accepted this job.");
    if (at < assignment.assignedAt) throw badRequest("Acceptance cannot precede assignment.");
    const updated = await tx.assignment.update({ where: { id: assignment.id }, data: { acceptedAt: at } });
    await recordAuditEvent(tx, {
      kind: "assignment_accepted",
      actorId: null,
      detail: `Agent ${input.agentId} accepted assignment ${assignment.id}.`,
      at,
    });
    return updated;
  });
}

/** Adds money to a job's escrow. Only the client that owns the job may fund it. */
export async function fundJob(input: { jobId: string; clientId: string; amountKsh: number; actorId: string }) {
  if (!Number.isInteger(input.amountKsh) || input.amountKsh <= 0) {
    throw badRequest("Enter a whole number of shillings above zero.");
  }
  return prisma.$transaction(async (tx) => {
    await lockJob(tx, input.jobId);
    const job = await tx.job.findUniqueOrThrow({ where: { id: input.jobId } });
    if (job.clientId !== input.clientId) throw notFound("Job");
    const deposit = await tx.escrowDeposit.create({
      data: { jobId: job.id, amountKsh: input.amountKsh, createdById: input.actorId },
    });
    await recordAuditEvent(tx, {
      kind: "escrow_funded",
      actorId: input.actorId,
      detail: `KSh ${input.amountKsh} deposited into escrow for job "${job.title}".`,
    });
    return deposit;
  });
}
