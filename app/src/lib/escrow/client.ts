import type { Job, Prisma } from "@prisma/client";
import { prisma, type Tx } from "@/lib/db";
import { notFound } from "@/lib/http/errors";
import { recordAuditEvent } from "@/lib/activations/transition";
import { assertCents, differenceCents, formatCents, sumCents } from "@/lib/money/cents";
import { jobEscrowFrom, type JobEscrow } from "./holds";

/**
 * A client business's escrow (FR-06, FR-07, FR-20, issue #42). The client
 * deposits into one balance. Publishing a job locks the job's maximum
 * liability from it; closing the job returns whatever of that lock was never
 * reserved, held or released. Every figure is derived from deposits, job
 * locks and hold states; no balance is stored.
 *
 *   available = deposited - sum over jobs of committed
 *   committed = the whole lock      while the job is open
 *             = reserved + held + released   once it is closed
 */
export type ClientEscrow = {
  depositedCents: number;
  committedCents: number;
  /** Never negative: publication is refused when it would be. */
  availableCents: number;
  jobs: Array<{ job: Job; escrow: JobEscrow }>;
};

export async function clientEscrow(db: Tx, clientId: string): Promise<ClientEscrow> {
  const [deposits, jobs] = await Promise.all([
    db.escrowDeposit.aggregate({ where: { clientId }, _sum: { amountCents: true } }),
    db.job.findMany({ where: { clientId }, orderBy: { createdAt: "desc" } }),
  ]);
  const holds = await db.escrowHoldState.findMany({ where: { jobId: { in: jobs.map((job) => job.id) } } });
  const perJob = jobs.map((job) => ({ job, escrow: jobEscrowFrom(job, holds.filter((hold) => hold.jobId === job.id)) }));
  const depositedCents = deposits._sum.amountCents ?? 0;
  const committedCents = sumCents(perJob.map((row) => row.escrow.committedCents));
  return { depositedCents, committedCents, availableCents: differenceCents(depositedCents, committedCents), jobs: perJob };
}

/** "KSh 34,000.00 deposited − KSh 24,000.00 committed to 2 jobs" */
export function availableDerivation(escrow: ClientEscrow): string {
  const count = escrow.jobs.length;
  return `${formatCents(escrow.depositedCents)} deposited − ${formatCents(escrow.committedCents)} committed to ${count} job${count === 1 ? "" : "s"}`;
}

/**
 * Serialises changes that can lower one client's available balance
 * (publishing a job), so two publications cannot both spend the same money.
 */
export async function lockClient(tx: Prisma.TransactionClient, clientId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "ClientBusiness" WHERE id = ${clientId} FOR UPDATE`;
  if (rows.length === 0) throw notFound("Client");
}

export type DepositInput = { clientId: string; amountCents: number; actorId: string; at?: Date };

/** Records a deposit inside an existing transaction. */
export async function recordDeposit(tx: Prisma.TransactionClient, input: DepositInput) {
  const amountCents = assertCents(input.amountCents, "The deposit");
  const deposit = await tx.escrowDeposit.create({
    data: { clientId: input.clientId, amountCents, createdById: input.actorId, createdAt: input.at },
  });
  await recordAuditEvent(tx, {
    kind: "escrow_funded",
    actorId: input.actorId,
    detail: `${formatCents(amountCents)} deposited into the client's escrow.`,
    at: input.at,
  });
  return deposit;
}

/** Adds money to a client's escrow balance. */
export async function fundEscrow(input: DepositInput) {
  return prisma.$transaction(async (tx) => {
    await lockClient(tx, input.clientId);
    return recordDeposit(tx, input);
  });
}
