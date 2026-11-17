import type { Job } from "@prisma/client";

/**
 * Whether a job still takes an assignment, from the same facts assignJob
 * checks: it is open, it has an unassigned slot, and its deadline has not
 * passed. A hint for the screen only; assignJob decides.
 */
export function openSlots(job: Pick<Job, "slots">, assigned: number): number {
  return Math.max(job.slots - assigned, 0);
}

export function canAssign(job: Pick<Job, "status" | "slots" | "deadlineAt">, assigned: number, now: Date = new Date()): boolean {
  if (job.status !== "open") return false;
  if (openSlots(job, assigned) === 0) return false;
  return job.deadlineAt === null || now <= job.deadlineAt;
}

/** The words for a job that cannot take an assignment, or null when it can. */
export function whyNotAssignable(job: Pick<Job, "status" | "slots" | "deadlineAt">, assigned: number, now: Date = new Date()): string | null {
  if (job.status !== "open") return "Closed";
  if (openSlots(job, assigned) === 0) return "Every slot is assigned";
  if (job.deadlineAt !== null && now > job.deadlineAt) return "Deadline passed";
  return null;
}
