import type { Prisma, ScoringJob, ScoringMode } from "@prisma/client";
import { prisma, type Tx } from "@/lib/db";
import { config } from "@/lib/config";
import type { ScoringTrigger } from "./decisions";

/**
 * Durable scoring schedule. Each activation has at most one job per mode
 * (unique on activationId + mode). The scheduler finds due rows by query and
 * claims one with a conditional update, so a restart neither loses a call
 * nor runs it twice.
 */

/** Schedules (or reschedules) the scoring call for one activation and mode. */
export async function enqueueScoring(
  tx: Tx,
  input: { activationId: string; mode: ScoringMode; dueAt: Date; trigger: ScoringTrigger },
): Promise<ScoringJob> {
  return tx.scoringJob.upsert({
    where: { activationId_mode: { activationId: input.activationId, mode: input.mode } },
    create: { ...input, status: "pending" },
    update: { dueAt: input.dueAt, trigger: input.trigger, status: "pending", attempts: 0, lockedUntil: null, lastError: null },
  });
}

function claimableWhere(now: Date): Prisma.ScoringJobWhereInput {
  return {
    OR: [
      { status: "pending", dueAt: { lte: now } },
      { status: "running", lockedUntil: { lt: now } },
    ],
  };
}

/**
 * Takes the job if it is due and nobody else holds it. Returns null when
 * another worker got there first or the job is not due.
 */
export async function claimJob(jobId: string, now: Date): Promise<ScoringJob | null> {
  const lockedUntil = new Date(now.getTime() + config().SCHEDULER_LEASE_SECONDS * 1000);
  const claimed = await prisma.scoringJob.updateMany({
    where: { id: jobId, ...claimableWhere(now) },
    data: { status: "running", lockedUntil, attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return null;
  return prisma.scoringJob.findUnique({ where: { id: jobId } });
}

export async function dueJobIds(now: Date, limit: number): Promise<string[]> {
  const jobs = await prisma.scoringJob.findMany({
    where: claimableWhere(now),
    orderBy: { dueAt: "asc" },
    take: limit,
    select: { id: true },
  });
  return jobs.map((job) => job.id);
}

export async function completeJob(tx: Tx, jobId: string, status: "succeeded" | "cancelled"): Promise<void> {
  await tx.scoringJob.update({ where: { id: jobId }, data: { status, lockedUntil: null } });
}

/**
 * After a failed run: retry later with doubling backoff, or give up once
 * SCORING_MAX_RUNS runs have failed. Returns the next due time, or null if
 * the job has failed for good.
 */
export async function rescheduleAfterFailure(tx: Tx, job: ScoringJob, error: string, now: Date): Promise<Date | null> {
  const { SCORING_MAX_RUNS, SCORING_RETRY_BASE_SECONDS } = config();
  if (job.attempts >= SCORING_MAX_RUNS) {
    await tx.scoringJob.update({ where: { id: job.id }, data: { status: "failed", lockedUntil: null, lastError: error } });
    return null;
  }
  const dueAt = new Date(now.getTime() + SCORING_RETRY_BASE_SECONDS * 1000 * 2 ** (job.attempts - 1));
  await tx.scoringJob.update({
    where: { id: job.id },
    data: { status: "pending", dueAt, lockedUntil: null, lastError: error },
  });
  return dueAt;
}
