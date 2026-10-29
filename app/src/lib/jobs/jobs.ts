import type { Job } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ApiError, conflict, notFound } from "@/lib/http/errors";
import { addConfigVersion } from "@/lib/evidence/config";
import { evidenceConfigInputSchema, nairobiDate } from "@/lib/evidence/fields";
import { recordAuditEvent } from "@/lib/activations/transition";
import { availableDerivation, clientEscrow, lockClient, recordDeposit } from "@/lib/escrow/client";
import { jobEscrow, lockJob, unspentDerivation, type JobEscrow } from "@/lib/escrow/holds";
import { explainStatus } from "@/lib/agents/explain";
import { differenceCents, formatCents, MoneyError, sumCents } from "@/lib/money/cents";
import {
  commissionView,
  computeCommission,
  liabilityDerivation,
  maxLiability,
  type CommissionView,
  type Liability,
} from "@/lib/money/commission";
import { centsSchema, latitudeSchema, longitudeSchema, nameSchema, rateBpsSchema } from "@/lib/validation";

/**
 * Jobs posted by client businesses (FR-04, FR-07, FR-18, FR-20). The client
 * sets the commission structure when posting: a rate in basis points applied
 * to the value of one approved submission, and an optional flat amount per
 * approved submission. Posting publishes the job and locks its maximum
 * liability from the client's escrow in the same transaction.
 *
 * The rate is also passed to the scoring service with each activation, as
 * the fraction the model was trained on; it is not a model feature.
 */
export const jobInputSchema = z
  .object({
    title: nameSchema,
    description: z.string().trim().min(10, "Describe the job in at least 10 characters.").max(2000),
    areaName: nameSchema,
    areaLat: latitudeSchema,
    areaLon: longitudeSchema,
    areaRadiusM: z.coerce.number().int().min(50, "Use a radius of at least 50 m.").max(50_000, "Use a radius of at most 50 km."),
    submissionValueCents: centsSchema("The submission value", 1),
    commissionRateBps: rateBpsSchema,
    flatCommissionCents: centsSchema("The flat commission").default(0),
    slots: z.coerce.number().int().min(1).max(10_000),
    initialDepositCents: centsSchema("The deposit").default(0),
    /** The last day work is accepted, YYYY-MM-DD in Kenya; the job closes to new work at the end of it (FR-04). */
    deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Give the deadline as a date, YYYY-MM-DD."),
    /** The evidence the agent must submit, in order (FR-05); version 1 of the job's configuration. */
    evidenceFields: evidenceConfigInputSchema.default([]),
  })
  .superRefine((job, ctx) => {
    try {
      if (computeCommission(job).amountCents === 0) {
        ctx.addIssue({ code: "custom", path: ["commissionRateBps"], message: "This structure pays nothing per approved submission. Raise the rate or add a flat amount." });
      }
      maxLiability(job, job.slots);
    } catch (error) {
      if (!(error instanceof MoneyError)) throw error;
      ctx.addIssue({ code: "custom", path: ["slots"], message: error.message });
    }
  });

export type JobInput = z.infer<typeof jobInputSchema>;

/** The job's commission per approved submission and its maximum liability, with derivations. */
export type JobTerms = { commission: CommissionView; liability: Liability & { derivation: string } };

export function jobTerms(job: Pick<Job, "submissionValueCents" | "commissionRateBps" | "flatCommissionCents" | "slots">): JobTerms {
  const liability = maxLiability(job, job.slots);
  return { commission: commissionView(computeCommission(job)), liability: { ...liability, derivation: liabilityDerivation(liability) } };
}

/**
 * Publishes a job (FR-07). In one transaction, with the client's balance
 * locked against concurrent publication: records the optional deposit,
 * checks the available balance covers the job's maximum liability, and
 * creates the job with that liability locked. If the balance falls short,
 * nothing is written, the deposit included.
 */
export async function createJob(input: { clientId: string; actorId: string; job: JobInput; at?: Date }) {
  const { job } = input;
  const terms = jobTerms(job);
  const deadlineAt = deadlineFor(job.deadline, input.at ?? new Date());
  return prisma.$transaction(async (tx) => {
    await lockClient(tx, input.clientId);
    if (job.initialDepositCents > 0) {
      await recordDeposit(tx, { clientId: input.clientId, amountCents: job.initialDepositCents, actorId: input.actorId, at: input.at });
    }
    const escrow = await clientEscrow(tx, input.clientId);
    if (escrow.availableCents < terms.liability.amountCents) {
      const shortfallCents = differenceCents(terms.liability.amountCents, escrow.availableCents);
      throw conflict(
        `Your available escrow (${formatCents(escrow.availableCents)}) does not cover this job's maximum liability of ` +
          `${formatCents(terms.liability.amountCents)} (${terms.liability.derivation}). Deposit at least ${formatCents(shortfallCents)} more.`,
        {
          availableCents: escrow.availableCents,
          availableDerivation: availableDerivation(escrow),
          neededCents: terms.liability.amountCents,
          neededDerivation: terms.liability.derivation,
          shortfallCents,
        },
      );
    }
    const created = await tx.job.create({
      data: {
        clientId: input.clientId,
        title: job.title,
        description: job.description,
        areaName: job.areaName,
        areaLat: job.areaLat,
        areaLon: job.areaLon,
        areaRadiusM: job.areaRadiusM,
        submissionValueCents: job.submissionValueCents,
        commissionRateBps: job.commissionRateBps,
        flatCommissionCents: job.flatCommissionCents,
        slots: job.slots,
        escrowLockedCents: terms.liability.amountCents,
        deadlineAt,
        createdAt: input.at,
      },
    });
    const config = await addConfigVersion(tx, { jobId: created.id, fields: job.evidenceFields, actorId: input.actorId, at: input.at });
    await recordAuditEvent(tx, {
      kind: "job_posted",
      actorId: input.actorId,
      detail:
        `Job "${created.title}" published: ${formatCents(terms.commission.amountCents)} per approved submission ` +
        `(${terms.commission.derivation}); ${formatCents(terms.liability.amountCents)} locked from the client's escrow (${terms.liability.derivation}); ` +
        `deadline ${job.deadline}; ${config.fields.length} evidence field(s), configuration version 1.`,
      at: input.at,
    });
    return created;
  });
}

/** The end of the deadline day in Kenya. It must fall on or after the publication date, within two years. */
function deadlineFor(deadline: string, publishedAt: Date): Date {
  const deadlineAt = new Date(`${deadline}T23:59:59.999+03:00`);
  const invalid = (message: string) => new ApiError(422, "validation_failed", message, [{ path: "deadline", message }]);
  if (Number.isNaN(deadlineAt.getTime()) || nairobiDate(deadlineAt) !== deadline) throw invalid("Give a real date as the deadline.");
  if (deadline < nairobiDate(publishedAt)) throw invalid("The deadline cannot be before the job is published.");
  if (deadlineAt.getTime() - publishedAt.getTime() > 2 * 366 * 24 * 60 * 60 * 1000) throw invalid("The deadline must be within two years.");
  return deadlineAt;
}

/**
 * Closes a job (FR-20). Its unspent remainder (the lock less everything
 * reserved, held or released) returns to the client's available balance at
 * once. Money still reserved or held stays committed until its activation is
 * decided: approval releases it to the agent, refusal or withdrawal returns
 * it to the client. A closed job takes no new assignments and cannot reopen.
 */
export async function closeJob(input: { jobId: string; clientId: string; actorId: string; at?: Date }) {
  const at = input.at ?? new Date();
  return prisma.$transaction(async (tx) => {
    await lockJob(tx, input.jobId);
    const job = await tx.job.findUniqueOrThrow({ where: { id: input.jobId } });
    if (job.clientId !== input.clientId) throw notFound("Job");
    if (job.status === "closed") throw conflict("This job is already closed.");
    const before = await jobEscrow(tx, job);
    const closed = await tx.job.update({ where: { id: job.id }, data: { status: "closed", closedAt: at } });
    await recordAuditEvent(tx, {
      kind: "job_closed",
      actorId: input.actorId,
      // In words rather than the display derivation, whose true minus sign
      // a database in a single-byte encoding (as the local one is) cannot store.
      detail:
        `Job "${job.title}" closed: ${formatCents(before.unspentCents)} returned to the client's available balance ` +
        `(${formatCents(before.lockedCents)} locked, less ${formatCents(sumCents([before.reservedCents, before.heldCents]))} in progress ` +
        `and ${formatCents(before.releasedCents)} released).`,
      at,
    });
    return { job: closed, returnedCents: before.unspentCents, returnedDerivation: unspentDerivation(before) };
  });
}

const activationInclude = {
  agent: { include: { user: true } },
  decisions: { orderBy: { recordedAt: "asc" as const }, include: { reasons: true } },
  reviewItems: { orderBy: { openedAt: "asc" as const } },
  evidenceRequests: { orderBy: { requestedAt: "asc" as const } },
  dispute: true,
  _count: { select: { activity: true } },
};

export type JobEscrowView = {
  job: Job;
  terms: JobTerms;
  escrow: JobEscrow;
  /** How the unspent figure was reached. */
  unspentDerivation: string;
};

function jobEscrowView(job: Job, escrow: JobEscrow): JobEscrowView {
  return { job, terms: jobTerms(job), escrow, unspentDerivation: unspentDerivation(escrow) };
}

export type ClientEscrowView = {
  depositedCents: number;
  committedCents: number;
  availableCents: number;
  availableDerivation: string;
  jobs: JobEscrowView[];
};

/** The client's balance and every job's escrow, each computed figure with its derivation (B5). */
export async function clientEscrowView(clientId: string): Promise<ClientEscrowView> {
  const escrow = await clientEscrow(prisma, clientId);
  return {
    depositedCents: escrow.depositedCents,
    committedCents: escrow.committedCents,
    availableCents: escrow.availableCents,
    availableDerivation: availableDerivation(escrow),
    jobs: escrow.jobs.map(({ job, escrow: perJob }) => jobEscrowView(job, perJob)),
  };
}

/** The client's balance, and each job with its escrow, slot use and outcome counts. */
export async function clientJobs(clientId: string) {
  const [view, slotCounts, outcomes] = await Promise.all([
    clientEscrowView(clientId),
    prisma.assignment.groupBy({ by: ["jobId"], where: { job: { clientId } }, _count: { _all: true } }),
    prisma.activation.groupBy({ by: ["jobId", "state"], where: { job: { clientId } }, _count: { _all: true } }),
  ]);
  return {
    ...view,
    jobs: view.jobs.map((row) => ({
      ...row,
      slotsUsed: slotCounts.find((count) => count.jobId === row.job.id)?._count._all ?? 0,
      outcomes: Object.fromEntries(outcomes.filter((o) => o.jobId === row.job.id).map((o) => [o.state, o._count._all])),
    })),
  };
}

/** One job of this client, with its escrow and every activation on it with the reason for its outcome. */
export async function clientJob(clientId: string, jobId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || job.clientId !== clientId) throw notFound("Job");
  const [escrow, activations] = await Promise.all([
    jobEscrow(prisma, job),
    prisma.activation.findMany({ where: { jobId }, include: activationInclude, orderBy: { submittedAt: "desc" } }),
  ]);
  return {
    ...jobEscrowView(job, escrow),
    activations: activations.map((activation) => ({
      activation,
      explanation: explainStatus(
        {
          state: activation.state,
          unscoredStage: activation.unscoredStage,
          holdClosesAt: activation.holdClosesAt,
          decisions: activation.decisions,
          closedReviews: activation.reviewItems.filter((item) => item.closedAt !== null),
          openRequestMessage: activation.evidenceRequests.findLast((r) => r.status === "open")?.message ?? null,
          dispute: activation.dispute,
          withdrawReason: activation.reviewItems.findLast((item) => item.action === "withdrawn_by_agent")?.reason ?? null,
        },
        "client",
      ),
    })),
  };
}

/** An activation on one of this client's jobs, with any activity already reported. */
export async function clientActivationForActivity(clientId: string, activationId: string) {
  const activation = await prisma.activation.findUnique({
    where: { id: activationId },
    include: { job: true, activity: { orderBy: { day: "asc" } } },
  });
  if (!activation || activation.job.clientId !== clientId) throw notFound("Activation");
  return activation;
}
