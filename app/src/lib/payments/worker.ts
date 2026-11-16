import { prisma } from "@/lib/db";
import { fits, NO_DEADLINE, paymentWorstCaseMs } from "@/lib/time-budget";
import { missingCredentials } from "./credentials";
import { checkDisbursement, expireStaleSends, reconcileDisbursement, sendDisbursement } from "./disbursement";
import { checkFunding, expireStaleFundingSends, reconcileFunding, sendFunding } from "./funding";

/**
 * The payment queue's worker. Nothing is held in memory between polls: the
 * queue is the FundingAttempt and Disbursement tables, so stopping and
 * restarting neither loses nor repeats an instruction. Several copies may run
 * at once, because each row is claimed by a conditional update.
 */
export type PaymentRunSummary = { skipped: boolean; sends: number; checks: number; expired: number; error: number; deferred: number };

const BATCH = 50;

async function dueIds(now: Date, take: number) {
  const due = { nextAttemptAt: { lte: now } };
  const select = { id: true } as const;
  const orderBy = { nextAttemptAt: "asc" } as const;
  const reconcilable = { reconcileUntil: { gt: now }, ...due };
  const [fundingSends, payoutSends, fundingChecks, payoutChecks, fundingReconciles, payoutReconciles] = await Promise.all([
    prisma.fundingAttempt.findMany({ where: { status: "queued", ...due }, select, orderBy, take }),
    prisma.disbursement.findMany({ where: { status: "queued", ...due }, select, orderBy, take }),
    prisma.fundingAttempt.findMany({ where: { status: "pending", escalatedAt: null, ...due }, select, orderBy, take }),
    prisma.disbursement.findMany({ where: { status: { in: ["sent", "unconfirmed"] }, escalatedAt: null, ...due }, select, orderBy, take }),
    prisma.fundingAttempt.findMany({ where: { status: "failed", resultCode: null, escalatedAt: null, ...reconcilable }, select, orderBy, take }),
    prisma.disbursement.findMany({ where: { status: "unconfirmed", escalatedAt: { not: null }, ...reconcilable }, select, orderBy, take }),
  ]);
  return { fundingSends, payoutSends, fundingChecks, payoutChecks, fundingReconciles, payoutReconciles };
}

/**
 * One row's failure is logged by id only and does not stop the others. A row
 * whose worst case no longer fits before the deadline is left due (deferred)
 * for the next run, never started.
 */
async function each(
  rows: Array<{ id: string }>,
  run: (id: string) => Promise<unknown>,
  summary: PaymentRunSummary,
  field: "sends" | "checks",
  deadline: number,
): Promise<void> {
  for (const [index, { id }] of rows.entries()) {
    if (!fits(deadline, paymentWorstCaseMs())) {
      summary.deferred += rows.length - index;
      return;
    }
    try {
      await run(id);
      summary[field] += 1;
    } catch {
      console.error(`[payments] instruction ${id} failed unexpectedly`);
      summary.error += 1;
    }
  }
}

/** Runs everything due. Waits, without using up any retries, until the credentials are set. */
export async function runDuePayments(now: Date = new Date(), take = BATCH, deadline: number = NO_DEADLINE): Promise<PaymentRunSummary> {
  const summary: PaymentRunSummary = { skipped: false, sends: 0, checks: 0, expired: 0, error: 0, deferred: 0 };
  if (missingCredentials().length > 0) return { ...summary, skipped: true };
  summary.expired = (await expireStaleSends(now)) + (await expireStaleFundingSends(now));
  const due = await dueIds(now, take);
  await each(due.fundingSends, (id) => sendFunding(id, now), summary, "sends", deadline);
  await each(due.payoutSends, (id) => sendDisbursement(id, now), summary, "sends", deadline);
  await each(due.fundingChecks, (id) => checkFunding(id, now), summary, "checks", deadline);
  await each(due.payoutChecks, (id) => checkDisbursement(id, now), summary, "checks", deadline);
  await each(due.fundingReconciles, (id) => reconcileFunding(id, now), summary, "checks", deadline);
  await each(due.payoutReconciles, (id) => reconcileDisbursement(id, now), summary, "checks", deadline);
  return summary;
}
