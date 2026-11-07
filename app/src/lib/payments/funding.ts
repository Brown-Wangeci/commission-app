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
import { stkPush, stkQuery, type DarajaOutcome, type StkAccepted } from "./daraja-client";

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
    data: { status: "confirmed", receipt, resultCode: "0", failureReason: null, lastError: null, lockedUntil: null, escalatedAt: null, resolvedAt: at },
  });
  await lockClient(tx, attempt.clientId);
  await recordDeposit(tx, { clientId: attempt.clientId, amountCents: attempt.amountCents, actorId: attempt.requestedById, fundingAttemptId: attempt.id, at });
  await notify(tx, { userId: attempt.requestedById, kind: "funding_confirmed", message: `${formatCents(attempt.amountCents)} received by M-Pesa (${receipt}) and added to your escrow.` });
}

/** A failure a callback reported. Holding `resultCode` marks it as Daraja's answer, not an inference. */
export async function failFunding(tx: Tx, attempt: FundingAttempt, resultCode: string, reason: string, at: Date): Promise<void> {
  await tx.fundingAttempt.update({
    where: { id: attempt.id },
    data: { status: "failed", resultCode, failureReason: reason, lastError: reason, lockedUntil: null, resolvedAt: at },
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

async function claimStatusCheck(id: string, now: Date): Promise<FundingAttempt | null> {
  const attempt = await prisma.fundingAttempt.findUnique({ where: { id } });
  if (!attempt) return null;
  const nextAttemptAt = new Date(now.getTime() + backoffMs(config().FUNDING_RESULT_WAIT_SECONDS, attempt.queryCount + 1));
  const claimed = await prisma.fundingAttempt.updateMany({
    where: { id, status: "pending", queryCount: attempt.queryCount, nextAttemptAt: { lte: now }, escalatedAt: null },
    data: { queryCount: { increment: 1 }, nextAttemptAt },
  });
  return claimed.count === 0 ? null : { ...attempt, queryCount: attempt.queryCount + 1 };
}

/** The result is overdue. Moves a pending attempt that can be moved. Never credits: only a callback can. */
export async function checkFunding(id: string, now: Date = new Date()): Promise<void> {
  const attempt = await claimStatusCheck(id, now);
  if (!attempt) return;
  if (!attempt.checkoutRequestId) return giveUp(attempt, "M-Pesa never confirmed this request.", now);
  const outcome = await stkQuery({ checkoutRequestId: attempt.checkoutRequestId, at: now });
  if (outcome.kind !== "accepted") return noAnswer(attempt, outcome.reason, now);
  const code = String(outcome.body.ResultCode ?? "");
  if (code === "0") return escalatePaidWithoutCallback(attempt, now);
  return giveUp(attempt, outcome.body.ResultDesc ?? `M-Pesa reported code ${code}.`, now);
}

async function noAnswer(attempt: FundingAttempt, reason: string, now: Date): Promise<void> {
  if (attempt.queryCount >= config().FUNDING_MAX_STATUS_QUERIES) return giveUp(attempt, `No result from M-Pesa after ${attempt.queryCount} checks.`, now);
  await prisma.fundingAttempt.updateMany({ where: { id: attempt.id, status: "pending" }, data: { lastError: reason } });
}

/** An inferred failure, so `resultCode` stays empty and a late success callback can still credit. */
async function giveUp(attempt: FundingAttempt, reason: string, now: Date): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const moved = await tx.fundingAttempt.updateMany({
      where: { id: attempt.id, status: "pending" },
      data: { status: "failed", failureReason: reason, lastError: reason, resolvedAt: now },
    });
    if (moved.count > 0) await reportFailure(tx, attempt, reason, now);
  });
}

async function escalatePaidWithoutCallback(attempt: FundingAttempt, now: Date): Promise<void> {
  const reason = "M-Pesa's status check says this was paid, but no callback arrived, so nothing has been credited.";
  await prisma.$transaction(async (tx) => {
    const moved = await tx.fundingAttempt.updateMany({ where: { id: attempt.id, status: "pending", escalatedAt: null }, data: { escalatedAt: now, lastError: reason } });
    if (moved.count > 0) await raiseToAdministrators(tx, { message: `Funding of ${formatCents(attempt.amountCents)} needs checking. ${reason}` });
  });
}

/** Most recent first, for the client's own screen (A3). */
export function listFundingAttempts(db: Tx, clientId: string, take = 20): Promise<FundingAttempt[]> {
  return db.fundingAttempt.findMany({ where: { clientId }, orderBy: { createdAt: "desc" }, take });
}
