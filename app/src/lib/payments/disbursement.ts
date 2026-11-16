import type { Disbursement, PayoutAuthorisation, Prisma } from "@prisma/client";
import { recordAuditEvent } from "@/lib/activations/transition";
import { config } from "@/lib/config";
import { prisma, type Tx } from "@/lib/db";
import { formatCents } from "@/lib/money/cents";
import { notify } from "@/lib/notifications";
import { b2cAmountProblem } from "./amount";
import { backoffMs, raiseToAdministrators } from "./attention";
import { b2cPayment, transactionStatus, type B2cAccepted, type DarajaOutcome } from "./daraja-client";
import { addMs, noAnswerDelayMs, reconcileDeadline, reconcileDelayMs, recordStatusCheck, type CheckPurpose } from "./status-checks";

/**
 * The B2C queue (FR-19, IR-03, NFR-04). Approval writes a row here inside its
 * own transaction and nothing else, so an M-Pesa outage cannot undo an
 * approval and a rolled-back approval cannot leave money moving. A worker
 * sends the row after the approval commits.
 *
 * The rule that prevents a double payment: a row may be sent again only if
 * Daraja cannot have processed it. Anything uncertain becomes `unconfirmed`,
 * which is resolved by asking Daraja, never by sending again. Every send
 * carries the same OriginatorConversationID, Daraja's own guard against double
 * disbursement, and a trigger stops the row going back to `queued`.
 */
export type SendOutcome = "sent" | "retrying" | "unconfirmed" | "failed" | "not_claimed";

const SENDABLE_AGAIN_FROM = "sending" as const;

function resultDue(now: Date): Date {
  return new Date(now.getTime() + config().PAYMENT_RESULT_WAIT_SECONDS * 1000);
}

/** Queues the instruction. An amount M-Pesa cannot take exactly fails here, visibly, and the approval stands. */
export async function queueDisbursement(tx: Tx, authorisation: PayoutAuthorisation, reference: string): Promise<Disbursement> {
  const problem = b2cAmountProblem(authorisation.amountCents);
  const at = authorisation.authorisedAt;
  const disbursement = await tx.disbursement.create({
    data: {
      reference,
      activationId: authorisation.activationId,
      commissionId: authorisation.commissionId,
      authorisationId: authorisation.id,
      amountCents: authorisation.amountCents,
      payoutMsisdn: authorisation.payoutMsisdn,
      nextAttemptAt: at,
      createdAt: at,
      ...(problem ? { status: "failed" as const, failureReason: problem, lastError: problem, escalatedAt: at, resolvedAt: at } : {}),
    },
  });
  if (problem) await reportFailure(tx, disbursement, problem, at);
  return disbursement;
}

async function claimDisbursement(id: string, now: Date): Promise<Disbursement | null> {
  const lockedUntil = new Date(now.getTime() + config().SCHEDULER_LEASE_SECONDS * 1000);
  const claimed = await prisma.disbursement.updateMany({
    where: { id, status: "queued", nextAttemptAt: { lte: now } },
    data: { status: "sending", lockedUntil, sendCount: { increment: 1 } },
  });
  if (claimed.count === 0) return null;
  return prisma.disbursement.findUnique({ where: { id } });
}

/** Sends one queued instruction. Safe to call from several workers at once: only one claims it. */
export async function sendDisbursement(id: string, now: Date = new Date()): Promise<SendOutcome> {
  const disbursement = await claimDisbursement(id, now);
  if (!disbursement) return "not_claimed";
  const activation = await prisma.activation.findUniqueOrThrow({ where: { id: disbursement.activationId }, select: { reference: true } });
  const outcome = await b2cPayment({
    reference: disbursement.reference,
    amountCents: disbursement.amountCents,
    payoutMsisdn: disbursement.payoutMsisdn,
    remarks: `Commission ${activation.reference}`,
  });
  return recordSend(disbursement, outcome, now);
}

/** Moves only a row still `sending`, because a callback may have settled it already. */
async function fromSending(id: string, data: Prisma.DisbursementUpdateManyMutationInput): Promise<boolean> {
  const updated = await prisma.disbursement.updateMany({ where: { id, status: SENDABLE_AGAIN_FROM }, data: { ...data, lockedUntil: null } });
  return updated.count > 0;
}

async function recordSend(disbursement: Disbursement, outcome: DarajaOutcome<B2cAccepted>, now: Date): Promise<SendOutcome> {
  if (outcome.kind === "accepted") return recordAccepted(disbursement, outcome.body, now);
  if (outcome.kind === "unknown") return markUnconfirmed(disbursement, outcome.reason, now);
  if (outcome.kind === "not_delivered") return retryOrFail(disbursement, outcome.reason, now);
  if (outcome.duplicate) return markUnconfirmed(disbursement, "Daraja already holds this instruction, so it was not sent again.", now);
  if (outcome.retryable) return retryOrFail(disbursement, outcome.reason, now);
  return failSend(disbursement, outcome.reason, outcome.code, now);
}

async function recordAccepted(disbursement: Disbursement, body: B2cAccepted, now: Date): Promise<SendOutcome> {
  const accepted = { conversationId: body.ConversationID, acceptedAt: now };
  const updated = await prisma.disbursement.updateMany({
    where: { id: disbursement.id, status: { in: ["sending", "unconfirmed"] } },
    data: { ...accepted, status: "sent", nextAttemptAt: resultDue(now), lockedUntil: null, lastError: null },
  });
  // The result callback can beat this response. Keep the id; the status is already final.
  if (updated.count === 0) await prisma.disbursement.update({ where: { id: disbursement.id }, data: accepted });
  return "sent";
}

async function markUnconfirmed(disbursement: Disbursement, reason: string, now: Date): Promise<SendOutcome> {
  await fromSending(disbursement.id, { status: "unconfirmed", nextAttemptAt: resultDue(now), lastError: reason });
  return "unconfirmed";
}

async function retryOrFail(disbursement: Disbursement, reason: string, now: Date): Promise<SendOutcome> {
  const { PAYMENT_MAX_SENDS, PAYMENT_RETRY_BASE_SECONDS } = config();
  if (disbursement.sendCount >= PAYMENT_MAX_SENDS) {
    return failSend(disbursement, `M-Pesa could not be reached after ${disbursement.sendCount} tries: ${reason}`, null, now);
  }
  const nextAttemptAt = new Date(now.getTime() + backoffMs(PAYMENT_RETRY_BASE_SECONDS, disbursement.sendCount));
  await fromSending(disbursement.id, { status: "queued", nextAttemptAt, lastError: reason });
  return "retrying";
}

async function failSend(disbursement: Disbursement, reason: string, code: string | null, now: Date): Promise<SendOutcome> {
  await prisma.$transaction(async (tx) => {
    const moved = await tx.disbursement.updateMany({
      where: { id: disbursement.id, status: SENDABLE_AGAIN_FROM },
      data: { status: "failed", failureReason: reason, lastError: reason, resultCode: code, lockedUntil: null, escalatedAt: now, resolvedAt: now },
    });
    if (moved.count > 0) await reportFailure(tx, disbursement, reason, now);
  });
  return "failed";
}

async function reportFailure(tx: Tx, disbursement: Disbursement, reason: string, at: Date): Promise<void> {
  await recordAuditEvent(tx, { kind: "payout_failed", activationId: disbursement.activationId, detail: `${formatCents(disbursement.amountCents)} not paid: ${reason}`, at });
  await raiseToAdministrators(tx, { activationId: disbursement.activationId, message: `A payout of ${formatCents(disbursement.amountCents)} failed: ${reason}` });
}

/** A success result, applied inside the callback's transaction with the row locked. */
export async function markPaid(tx: Tx, disbursement: Disbursement, input: { receipt: string; conversationId: string | null; at: Date }): Promise<void> {
  await tx.disbursement.update({
    where: { id: disbursement.id },
    data: {
      status: "paid",
      receipt: input.receipt,
      conversationId: disbursement.conversationId ?? input.conversationId,
      resultCode: "0",
      failureReason: null,
      lastError: null,
      lockedUntil: null,
      escalatedAt: null,
      reconcileUntil: null,
      resolvedAt: input.at,
    },
  });
  await recordAuditEvent(tx, { kind: "payout_paid", activationId: disbursement.activationId, detail: `${formatCents(disbursement.amountCents)} paid by M-Pesa, receipt ${input.receipt}.`, at: input.at });
  const agent = await tx.activation.findUniqueOrThrow({ where: { id: disbursement.activationId }, select: { reference: true, agent: { select: { userId: true } } } });
  await notify(tx, {
    userId: agent.agent.userId,
    kind: "payout_paid",
    activationId: disbursement.activationId,
    message: `${formatCents(disbursement.amountCents)} for ${agent.reference} was sent to your M-Pesa (${input.receipt}).`,
  });
}

/** A failure result, applied inside the callback's transaction with the row locked. */
export async function markFailed(tx: Tx, disbursement: Disbursement, input: { resultCode: string; reason: string; conversationId: string | null; at: Date }): Promise<void> {
  await tx.disbursement.update({
    where: { id: disbursement.id },
    data: {
      status: "failed",
      conversationId: disbursement.conversationId ?? input.conversationId,
      resultCode: input.resultCode,
      failureReason: input.reason,
      lastError: input.reason,
      lockedUntil: null,
      escalatedAt: input.at,
      reconcileUntil: null,
      resolvedAt: input.at,
    },
  });
  await reportFailure(tx, disbursement, input.reason, input.at);
}

/** A worker that stopped mid-send may have reached Daraja, so the row becomes unconfirmed, never queued. */
export async function expireStaleSends(now: Date): Promise<number> {
  const expired = await prisma.disbursement.updateMany({
    where: { status: "sending", lockedUntil: { lt: now } },
    data: { status: "unconfirmed", lockedUntil: null, nextAttemptAt: now, lastError: "A worker stopped while sending, so the outcome is unknown." },
  });
  return expired.count;
}

/*
 * Status checks. Asking is not sending: it can never pay anything twice. The
 * answer to a status query arrives later, by callback, and is applied by the
 * same verified path as any other result.
 *   result_wait  the result is overdue. Daraja is asked until it has accepted
 *                PAYMENT_MAX_STATUS_QUERIES queries or PAYMENT_ESCALATE_AFTER_SECONDS
 *                pass, then it is raised (defect 10).
 *   reconcile    after it was raised, Daraja is still asked, slowly, for a
 *                bounded period (defect 12).
 * A query Daraja could not take (HTTP 429, a timeout) is recorded but does not
 * use up a query, and its Retry-After is honoured.
 */

/** One worker wins the claim by moving the due time a lease ahead, so a worker that dies mid-check is retried later. */
async function claimStatusCheck(id: string, now: Date, purpose: CheckPurpose): Promise<Disbursement | null> {
  const lease = new Date(now.getTime() + config().SCHEDULER_LEASE_SECONDS * 1000);
  const due = { id, nextAttemptAt: { lte: now } };
  const claimed =
    purpose === "result_wait"
      ? await prisma.disbursement.updateMany({ where: { ...due, status: { in: ["sent", "unconfirmed"] }, escalatedAt: null }, data: { status: "unconfirmed", nextAttemptAt: lease } })
      : await prisma.disbursement.updateMany({ where: { ...due, status: "unconfirmed", escalatedAt: { not: null }, reconcileUntil: { gt: now } }, data: { nextAttemptAt: lease } });
  return claimed.count === 0 ? null : prisma.disbursement.findUnique({ where: { id } });
}

function escalateAt(disbursement: Disbursement): Date {
  return addMs(disbursement.acceptedAt ?? disbursement.createdAt, config().PAYMENT_ESCALATE_AFTER_SECONDS * 1000);
}

/** The result is overdue. Asks Daraja where the instruction stands; the answer arrives by callback. */
export async function checkDisbursement(id: string, now: Date = new Date()): Promise<void> {
  const disbursement = await claimStatusCheck(id, now, "result_wait");
  if (!disbursement) return;
  if (disbursement.queryCount >= config().PAYMENT_MAX_STATUS_QUERIES || now >= escalateAt(disbursement)) return escalateUnresolved(disbursement, now);
  await askDaraja(disbursement, now, "result_wait");
}

/** After it was raised: asks Daraja again, slowly. Never sends the payout again. */
export async function reconcileDisbursement(id: string, now: Date = new Date()): Promise<void> {
  const disbursement = await claimStatusCheck(id, now, "reconcile");
  if (disbursement) await askDaraja(disbursement, now, "reconcile");
}

async function askDaraja(disbursement: Disbursement, now: Date, purpose: CheckPurpose): Promise<void> {
  const outcome = await transactionStatus({ reference: disbursement.reference });
  const waiting = purpose === "result_wait";
  if (outcome.kind === "accepted") {
    const nextAttemptAt = addMs(now, waiting ? backoffMs(config().PAYMENT_RESULT_WAIT_SECONDS, disbursement.queryCount + 1) : reconcileDelayMs(null));
    await recordStatusCheck(prisma, { disbursementId: disbursement.id }, { purpose, outcome, counted: true, at: now, nextCheckAt: nextAttemptAt });
    await prisma.disbursement.update({ where: { id: disbursement.id }, data: { queryCount: { increment: 1 }, nextAttemptAt } });
    return;
  }
  const delay = waiting ? noAnswerDelayMs(disbursement.noAnswerCount, outcome.retryAfterSeconds) : reconcileDelayMs(outcome.retryAfterSeconds);
  const nextAttemptAt = waiting ? new Date(Math.min(addMs(now, delay).getTime(), escalateAt(disbursement).getTime())) : addMs(now, delay);
  await recordStatusCheck(prisma, { disbursementId: disbursement.id }, { purpose, outcome, counted: false, at: now, nextCheckAt: nextAttemptAt });
  const data: Prisma.DisbursementUpdateManyMutationInput = { nextAttemptAt, noAnswerCount: { increment: 1 } };
  await prisma.disbursement.updateMany({ where: { id: disbursement.id, status: "unconfirmed" }, data: waiting ? { ...data, lastError: outcome.reason } : data });
}

async function escalateUnresolved(disbursement: Disbursement, now: Date): Promise<void> {
  const reason = "M-Pesa has not confirmed this payout. It will not be sent again. Check the M-Pesa portal before paying by any other route.";
  await prisma.$transaction(async (tx) => {
    const moved = await tx.disbursement.updateMany({
      where: { id: disbursement.id, status: "unconfirmed", escalatedAt: null },
      data: { escalatedAt: now, lastError: reason, reconcileUntil: reconcileDeadline(now), nextAttemptAt: addMs(now, reconcileDelayMs(null)) },
    });
    if (moved.count === 0) return;
    await recordAuditEvent(tx, { kind: "payout_unconfirmed", activationId: disbursement.activationId, detail: `${formatCents(disbursement.amountCents)}: ${reason}`, at: now });
    await raiseToAdministrators(tx, { activationId: disbursement.activationId, message: `A payout of ${formatCents(disbursement.amountCents)} needs checking. ${reason}` });
  });
}
