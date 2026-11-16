import type { FundingAttempt, Prisma } from "@prisma/client";
import { recordAuditEvent } from "@/lib/activations/transition";
import { config } from "@/lib/config";
import { prisma, type Tx } from "@/lib/db";
import { recordDeposit, lockClient } from "@/lib/escrow/client";
import { ApiError, notFound } from "@/lib/http/errors";
import { formatCents } from "@/lib/money/cents";
import { notify } from "@/lib/notifications";
import { stkAmountProblem } from "./amount";
import { backoffMs, raiseToAdministrators } from "./attention";
import { newReference } from "./callback-url";
import { mpesaCredentials } from "./credentials";
import { stkPush, stkQuery, type DarajaOutcome, type StkAccepted, type StkQueryAccepted } from "./daraja-client";
import { addMs, noAnswerDelayMs, reconcileDeadline, reconcileDelayMs, recordStatusCheck, stkAnswer, wholeMinutes, type CheckPurpose } from "./status-checks";

/**
 * Funding the escrow balance by STK Push (FR-06). Starting an attempt moves no
 * money. Only `confirmFunding`, reached from a verified callback, credits the
 * balance, and a database trigger refuses any deposit without a confirmed
 * attempt behind it.
 */
export type FundingOutcome = "pending" | "retrying" | "failed" | "not_claimed";

function unavailable(): ApiError {
  return new ApiError(503, "payments_unavailable", "M-Pesa funding is not available right now. Nothing was charged.");
}

function leaseEnd(now: Date): Date {
  return new Date(now.getTime() + config().SCHEDULER_LEASE_SECONDS * 1000);
}

/** Records the attempt, then sends the prompt straight away so the payer is not kept waiting. */
export async function startFunding(input: {
  clientId: string;
  actorId: string;
  amountCents: number;
  payerMsisdn: string;
  at?: Date;
}): Promise<FundingAttempt> {
  if (!mpesaCredentials()) throw unavailable();
  const problem = stkAmountProblem(input.amountCents);
  if (problem) throw new ApiError(422, "validation_failed", problem, [{ path: "amountCents", message: problem }]);
  const at = input.at ?? new Date();
  const created = await prisma.$transaction((tx) => createAttempt(tx, input, at));
  await sendFunding(created.id, at);
  return prisma.fundingAttempt.findUniqueOrThrow({ where: { id: created.id } });
}

async function createAttempt(tx: Tx, input: Parameters<typeof startFunding>[0], at: Date): Promise<FundingAttempt> {
  const client = await tx.clientBusiness.findUnique({ where: { id: input.clientId } });
  if (!client) throw notFound("Client");
  const attempt = await tx.fundingAttempt.create({
    data: {
      reference: newReference(),
      clientId: input.clientId,
      requestedById: input.actorId,
      amountCents: input.amountCents,
      payerMsisdn: input.payerMsisdn,
      nextAttemptAt: at,
      createdAt: at,
    },
  });
  await recordAuditEvent(tx, {
    kind: "funding_requested",
    actorId: input.actorId,
    detail: `${formatCents(input.amountCents)} requested by M-Pesa. Nothing is credited until M-Pesa confirms it.`,
    at,
  });
  return attempt;
}

async function claimFunding(id: string, now: Date): Promise<FundingAttempt | null> {
  const claimed = await prisma.fundingAttempt.updateMany({
    where: { id, status: "queued", nextAttemptAt: { lte: now } },
    data: { status: "sending", lockedUntil: leaseEnd(now), sendCount: { increment: 1 } },
  });
  if (claimed.count === 0) return null;
  return prisma.fundingAttempt.findUnique({ where: { id } });
}

/** Sends one queued attempt. Safe to call from several workers at once. */
export async function sendFunding(id: string, now: Date = new Date()): Promise<FundingOutcome> {
  const attempt = await claimFunding(id, now);
  if (!attempt) return "not_claimed";
  const outcome = await stkPush({ reference: attempt.reference, amountCents: attempt.amountCents, payerMsisdn: attempt.payerMsisdn, at: now });
  return recordFundingSend(attempt, outcome, now);
}

/** Moves only a row still `sending`, because a callback may have settled it already. */
async function fromSending(id: string, data: Prisma.FundingAttemptUpdateManyMutationInput): Promise<boolean> {
  const updated = await prisma.fundingAttempt.updateMany({ where: { id, status: "sending" }, data: { ...data, lockedUntil: null } });
  return updated.count > 0;
}

async function recordFundingSend(attempt: FundingAttempt, outcome: DarajaOutcome<StkAccepted>, now: Date): Promise<FundingOutcome> {
  const waitMs = config().FUNDING_RESULT_WAIT_SECONDS * 1000;
  const resultDue = new Date(now.getTime() + waitMs);
  if (outcome.kind === "accepted") return recordAccepted(attempt, outcome.body, resultDue);
  // No answer: the prompt may be on the phone. Sending again could charge twice,
  // so wait for the callback, which its URL ties to this attempt.
  if (outcome.kind === "unknown") {
    await fromSending(attempt.id, { status: "pending", nextAttemptAt: resultDue, lastError: outcome.reason });
    return "pending";
  }
  if (outcome.kind === "refused" && !outcome.retryable) return failSend(attempt, outcome.reason, now);
  return retryOrFail(attempt, outcome.reason, now);
}

async function recordAccepted(attempt: FundingAttempt, body: StkAccepted, resultDue: Date): Promise<FundingOutcome> {
  const ids = { merchantRequestId: body.MerchantRequestID, checkoutRequestId: body.CheckoutRequestID };
  const moved = await fromSending(attempt.id, { ...ids, status: "pending", nextAttemptAt: resultDue, lastError: null });
  if (!moved) await prisma.fundingAttempt.update({ where: { id: attempt.id }, data: ids });
  return "pending";
}

async function retryOrFail(attempt: FundingAttempt, reason: string, now: Date): Promise<FundingOutcome> {
  const { FUNDING_MAX_SENDS, FUNDING_RETRY_BASE_SECONDS } = config();
  if (attempt.sendCount >= FUNDING_MAX_SENDS) {
    return failSend(attempt, `M-Pesa could not be reached after ${attempt.sendCount} tries: ${reason}`, now);
  }
  const nextAttemptAt = new Date(now.getTime() + backoffMs(FUNDING_RETRY_BASE_SECONDS, attempt.sendCount));
  await fromSending(attempt.id, { status: "queued", nextAttemptAt, lastError: reason });
  return "retrying";
}

async function failSend(attempt: FundingAttempt, reason: string, now: Date): Promise<FundingOutcome> {
  await prisma.$transaction(async (tx) => {
    const moved = await tx.fundingAttempt.updateMany({
      where: { id: attempt.id, status: "sending" },
      data: { status: "failed", failureReason: reason, lastError: reason, lockedUntil: null, resolvedAt: now },
    });
    if (moved.count > 0) await reportFailure(tx, attempt, reason, now);
  });
  return "failed";
}

async function reportFailure(tx: Tx, attempt: FundingAttempt, reason: string, at: Date): Promise<void> {
  await recordAuditEvent(tx, { kind: "funding_failed", actorId: attempt.requestedById, detail: `${formatCents(attempt.amountCents)} not funded: ${reason}`, at });
  await notify(tx, { userId: attempt.requestedById, kind: "funding_failed", message: `Your ${formatCents(attempt.amountCents)} escrow funding failed: ${reason}` });
}

/**
 * Credits the balance. Called only from a verified callback, inside its
 * transaction, with the attempt locked. The trigger on EscrowDeposit checks
 * the status set here, and the unique attempt id stops a second credit.
 */
export async function confirmFunding(tx: Tx, attempt: FundingAttempt, receipt: string, at: Date): Promise<void> {
  await tx.fundingAttempt.update({
    where: { id: attempt.id },
    data: { status: "confirmed", receipt, resultCode: "0", failureReason: null, lastError: null, lockedUntil: null, escalatedAt: null, reconcileUntil: null, resolvedAt: at },
  });
  await lockClient(tx, attempt.clientId);
  await recordDeposit(tx, { clientId: attempt.clientId, amountCents: attempt.amountCents, actorId: attempt.requestedById, fundingAttemptId: attempt.id, at });
  await notify(tx, { userId: attempt.requestedById, kind: "funding_confirmed", message: `${formatCents(attempt.amountCents)} received by M-Pesa (${receipt}) and added to your escrow.` });
}

/** A failure a callback reported. Holding `resultCode` marks it as Daraja's answer, not an inference. */
export async function failFunding(tx: Tx, attempt: FundingAttempt, resultCode: string, reason: string, at: Date): Promise<void> {
  await tx.fundingAttempt.update({
    where: { id: attempt.id },
    data: { status: "failed", resultCode, failureReason: reason, lastError: reason, lockedUntil: null, reconcileUntil: null, resolvedAt: at },
  });
  await reportFailure(tx, attempt, reason, at);
}

/** A worker that stopped mid-send leaves the outcome unknown, so the attempt waits for its callback. */
export async function expireStaleFundingSends(now: Date): Promise<number> {
  const expired = await prisma.fundingAttempt.updateMany({
    where: { status: "sending", lockedUntil: { lt: now } },
    data: { status: "pending", lockedUntil: null, nextAttemptAt: now, lastError: "A worker stopped while sending, so the outcome is unknown." },
  });
  return expired.count;
}

/*
 * Status checks. Two kinds, one query:
 *   result_wait  the first result is overdue. Daraja is asked until it answers
 *                or FUNDING_GIVE_UP_AFTER_SECONDS pass (defect 10).
 *   reconcile    the app has marked the attempt failed without an answer, so
 *                Daraja is still asked, slowly, for a bounded period (defect 12).
 * Neither ever credits. Only a verified callback does.
 */

/** One worker wins the claim by moving the due time a lease ahead, so a worker that dies mid-check is retried later. */
async function claimStatusCheck(id: string, now: Date, purpose: CheckPurpose): Promise<FundingAttempt | null> {
  const due = { id, nextAttemptAt: { lte: now }, escalatedAt: null };
  const where: Prisma.FundingAttemptWhereInput =
    purpose === "result_wait" ? { ...due, status: "pending" } : { ...due, status: "failed", resultCode: null, reconcileUntil: { gt: now } };
  const claimed = await prisma.fundingAttempt.updateMany({ where, data: { nextAttemptAt: leaseEnd(now) } });
  return claimed.count === 0 ? null : prisma.fundingAttempt.findUnique({ where: { id } });
}

/** The result is overdue. Moves a pending attempt that can be moved. Never credits: only a callback can. */
export async function checkFunding(id: string, now: Date = new Date()): Promise<void> {
  const attempt = await claimStatusCheck(id, now, "result_wait");
  if (!attempt) return;
  if (!attempt.checkoutRequestId) return giveUp(attempt, "M-Pesa never confirmed this request.", now, false);
  await askDaraja(attempt, now, "result_wait");
}

/** After an inferred failure: asks Daraja again, slowly. Raises a success, closes on a failure, otherwise waits. */
export async function reconcileFunding(id: string, now: Date = new Date()): Promise<void> {
  const attempt = await claimStatusCheck(id, now, "reconcile");
  if (!attempt?.checkoutRequestId) return;
  await askDaraja(attempt, now, "reconcile");
}

async function askDaraja(attempt: FundingAttempt, now: Date, purpose: CheckPurpose): Promise<void> {
  const outcome = await stkQuery({ checkoutRequestId: attempt.checkoutRequestId as string, at: now });
  const answer = stkAnswer(outcome);
  if (!answer) return noAnswer(attempt, outcome, now, purpose);
  await recordStatusCheck(prisma, { fundingAttemptId: attempt.id }, { purpose, outcome, counted: true, at: now, nextCheckAt: null });
  await prisma.fundingAttempt.update({ where: { id: attempt.id }, data: { queryCount: { increment: 1 } } });
  if (answer.code === "0") return escalatePaidWithoutCallback(attempt, now);
  const reason = answer.description ?? `M-Pesa reported code ${answer.code}.`;
  return purpose === "result_wait" ? giveUp(attempt, reason, now, false) : closeReconciliation(attempt);
}

function giveUpAt(attempt: FundingAttempt): Date {
  return addMs(attempt.createdAt, config().FUNDING_GIVE_UP_AFTER_SECONDS * 1000);
}

/**
 * Daraja gave no result (HTTP 429, a timeout, "being processed"). The check is
 * recorded but not counted. Waiting is bounded by time: a result wait ends at
 * the give-up time, a reconciliation at its deadline.
 */
async function noAnswer(attempt: FundingAttempt, outcome: DarajaOutcome<StkQueryAccepted>, now: Date, purpose: CheckPurpose): Promise<void> {
  const limit = giveUpAt(attempt);
  const waiting = purpose === "result_wait";
  if (waiting && now >= limit) {
    await recordStatusCheck(prisma, { fundingAttemptId: attempt.id }, { purpose, outcome, counted: false, at: now, nextCheckAt: null });
    return giveUp(attempt, `No result from M-Pesa within ${wholeMinutes(config().FUNDING_GIVE_UP_AFTER_SECONDS)} minutes.`, now, true);
  }
  const next = waiting ? new Date(Math.min(addMs(now, noAnswerDelayMs(attempt.noAnswerCount, outcome.retryAfterSeconds)).getTime(), limit.getTime())) : addMs(now, reconcileDelayMs(outcome.retryAfterSeconds));
  await recordStatusCheck(prisma, { fundingAttemptId: attempt.id }, { purpose, outcome, counted: false, at: now, nextCheckAt: next });
  const data: Prisma.FundingAttemptUpdateManyMutationInput = { nextAttemptAt: next, noAnswerCount: { increment: 1 } };
  await prisma.fundingAttempt.updateMany({ where: { id: attempt.id, status: waiting ? "pending" : "failed" }, data: waiting ? { ...data, lastError: outcome.kind === "accepted" ? "Daraja gave no result." : outcome.reason } : data });
}

/**
 * An inferred failure, so `resultCode` stays empty and a late success callback
 * can still credit. With `reconcile`, Daraja is also asked again, slowly, in
 * case the payment completes late.
 */
async function giveUp(attempt: FundingAttempt, reason: string, now: Date, reconcile: boolean): Promise<void> {
  const again = reconcile ? { reconcileUntil: reconcileDeadline(now), nextAttemptAt: addMs(now, reconcileDelayMs(null)) } : {};
  await prisma.$transaction(async (tx) => {
    const moved = await tx.fundingAttempt.updateMany({
      where: { id: attempt.id, status: "pending" },
      data: { status: "failed", failureReason: reason, lastError: reason, resolvedAt: now, ...again },
    });
    if (moved.count > 0) await reportFailure(tx, attempt, reason, now);
  });
}

/** Daraja says it is not paid: nothing more to ask. The row stays as it is. */
async function closeReconciliation(attempt: FundingAttempt): Promise<void> {
  await prisma.fundingAttempt.updateMany({ where: { id: attempt.id, status: "failed" }, data: { reconcileUntil: null } });
}

/**
 * Daraja's status check says this was paid, and no callback came. It is raised
 * to an administrator and nothing is credited, because a status answer carries
 * no receipt and no amount, and M-Pesa may have reversed the payment since:
 * on 2026-11-16 Daraja still answered "processed successfully" for a payment
 * its own sandbox had reversed. A late verified callback still credits, once.
 */
async function escalatePaidWithoutCallback(attempt: FundingAttempt, now: Date): Promise<void> {
  const reason = "M-Pesa's status check says this was paid, but no callback arrived, so nothing has been credited. Check the M-Pesa portal: it may since have been reversed.";
  await prisma.$transaction(async (tx) => {
    const moved = await tx.fundingAttempt.updateMany({
      where: { id: attempt.id, status: { in: ["pending", "failed"] }, resultCode: null, escalatedAt: null },
      data: { escalatedAt: now, lastError: reason, reconcileUntil: null },
    });
    if (moved.count > 0) await raiseToAdministrators(tx, { message: `Funding of ${formatCents(attempt.amountCents)} needs checking. ${reason}` });
  });
}

/** Most recent first, for the client's own screen (A3). */
export function listFundingAttempts(db: Tx, clientId: string, take = 20): Promise<FundingAttempt[]> {
  return db.fundingAttempt.findMany({ where: { clientId }, orderBy: { createdAt: "desc" }, take });
}
