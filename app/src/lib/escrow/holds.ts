import type { EscrowHoldState, Job, Prisma } from "@prisma/client";
import { prisma, type Tx } from "@/lib/db";
import { badRequest, conflict, notFound } from "@/lib/http/errors";
import { recordAuditEvent } from "@/lib/activations/transition";
import { differenceCents, formatCents, sumCents } from "@/lib/money/cents";
import { computeCommission } from "@/lib/money/commission";

/** Hold states as the EscrowHoldState view reports them. */
export type HoldState = "reserved" | "held" | "released" | "returned";

/**
 * One job's escrow, derived from its lock and the state of its holds (issue
 * #42). Nothing here is stored: the lock is fixed at publication and each
 * hold's state comes from its activation's state (issue #5).
 */
export type JobEscrow = {
  /** Locked from the client's balance at publication. */
  lockedCents: number;
  reservedCents: number;
  heldCents: number;
  releasedCents: number;
  returnedCents: number;
  /** Locked money not reserved, held or released: free within the lock while the job is open, back with the client once it closes. */
  unspentCents: number;
  /** What the job takes from the client's balance: the whole lock while open; only reserved, held and released money once closed. */
  committedCents: number;
};

type LockedJob = Pick<Job, "status" | "escrowLockedCents">;

export async function holdStateFor(db: Tx, assignmentId: string): Promise<EscrowHoldState | null> {
  return db.escrowHoldState.findUnique({ where: { assignmentId } });
}

function sumBy(holds: EscrowHoldState[], state: HoldState): number {
  return sumCents(holds.filter((hold) => hold.state === state).map((hold) => hold.amountCents));
}

export function jobEscrowFrom(job: LockedJob, holds: EscrowHoldState[]): JobEscrow {
  const reservedCents = sumBy(holds, "reserved");
  const heldCents = sumBy(holds, "held");
  const releasedCents = sumBy(holds, "released");
  const spokenFor = sumCents([reservedCents, heldCents, releasedCents]);
  return {
    lockedCents: job.escrowLockedCents,
    reservedCents,
    heldCents,
    releasedCents,
    returnedCents: sumBy(holds, "returned"),
    unspentCents: differenceCents(job.escrowLockedCents, spokenFor),
    committedCents: job.status === "open" ? job.escrowLockedCents : spokenFor,
  };
}

export async function jobEscrow(db: Tx, job: LockedJob & { id: string }): Promise<JobEscrow> {
  return jobEscrowFrom(job, await db.escrowHoldState.findMany({ where: { jobId: job.id } }));
}

/** "KSh 900.00 locked − KSh 300.00 in progress − KSh 300.00 released" */
export function unspentDerivation(escrow: JobEscrow): string {
  const inProgress = sumCents([escrow.reservedCents, escrow.heldCents]);
  return `${formatCents(escrow.lockedCents)} locked − ${formatCents(inProgress)} in progress − ${formatCents(escrow.releasedCents)} released`;
}

/** Serialises escrow changes on one job, so two assignments cannot overspend its lock. */
export async function lockJob(tx: Prisma.TransactionClient, jobId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Job" WHERE id = ${jobId} FOR UPDATE`;
  if (rows.length === 0) throw notFound("Job");
}

export type AssignInput = { jobId: string; agentId: string; assignedById: string; at?: Date };

/**
 * Assigns one slot of a job to an agent and reserves one commission's worth
 * of the job's locked escrow in a hold, in a single transaction. Fails if the
 * job is closed, out of slots, or (for a job converted from the old per-job
 * funding) its lock does not cover another commission.
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
    const commissionCents = computeCommission(job).amountCents;
    const escrow = await jobEscrow(tx, job);
    if (escrow.unspentCents < commissionCents) {
      throw conflict("The job's locked escrow does not cover another commission.", {
        unspentCents: escrow.unspentCents,
        neededCents: commissionCents,
      });
    }
    const assignment = await tx.assignment.create({
      data: {
        jobId: job.id,
        agentId: agent.id,
        assignedById: input.assignedById,
        assignedAt: at,
        hold: { create: { amountCents: commissionCents, createdAt: at } },
      },
      include: { hold: true },
    });
    await recordAuditEvent(tx, {
      kind: "job_assigned",
      actorId: input.assignedById,
      detail: `Job "${job.title}" assigned to agent ${agent.id}; ${formatCents(commissionCents)} reserved from the job's locked escrow.`,
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
