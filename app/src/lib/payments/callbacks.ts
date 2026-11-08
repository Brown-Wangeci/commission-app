import { createHash, randomUUID } from "node:crypto";
import type { Disbursement, FundingAttempt, PaymentCallbackOutcome } from "@prisma/client";
import { prisma, type Tx } from "@/lib/db";
import { formatCents } from "@/lib/money/cents";
import { raiseToAdministrators } from "./attention";
import { parseB2cResult, parseStatusResult, parseStkCallback, type ParsedResult } from "./callback-parse";
import type { CallbackKind } from "./callback-url";
import { markFailed, markPaid } from "./disbursement";
import { confirmFunding, failFunding } from "./funding";

/**
 * Applies a callback whose origin has been verified (IR-02). Each distinct
 * result is applied once: `registerDelivery` is a single insert on a unique
 * key, so a replay, even a concurrent one, only raises a counter. Everything
 * runs in one transaction, so a failure part-way leaves no trace and the
 * callback can be delivered again.
 *
 * Callbacks can arrive early, late, twice, or contradict each other. Two rules
 * keep that safe: a settled record never changes on a callback's say-so, and a
 * contradiction is recorded and shown to an administrator, never guessed at.
 */
type Applied = { outcome: PaymentCallbackOutcome; note?: string };

const FINAL_FAILURE_STATUSES = new Set(["Declined", "Cancelled", "Expired"]);

function parse(kind: CallbackKind, payload: unknown): ParsedResult | null {
  if (kind === "stk") return parseStkCallback(payload);
  if (kind === "b2c-result") return parseB2cResult(payload);
  if (kind === "status-result") return parseStatusResult(payload);
  return null;
}

function dedupeKey(kind: CallbackKind, reference: string, parsed: ParsedResult | null): string {
  const parts = [kind, reference, parsed?.resultCode ?? "", parsed?.receipt ?? "", parsed?.transactionStatus ?? ""];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/** Holds no phone number or name: only what the parser kept. */
function summaryOf(parsed: ParsedResult | null): string {
  if (!parsed) return "{}";
  const { resultCode, resultDesc, receipt, amountCents, conversationId, transactionStatus } = parsed;
  return JSON.stringify({ resultCode, resultDesc, receipt, amountCents, conversationId, transactionStatus });
}

/** True the first time this result is seen. The unique key decides, so concurrent replays cannot both win. */
async function registerDelivery(tx: Tx, kind: CallbackKind, reference: string, key: string, parsed: ParsedResult | null): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ deliveries: number }>>`
    INSERT INTO "PaymentCallback" ("id", "kind", "reference", "dedupeKey", "outcome", "resultCode", "summary")
    VALUES (${randomUUID()}, ${kind}, ${reference}, ${key}, 'applied'::"PaymentCallbackOutcome", ${parsed?.resultCode ?? null}, ${summaryOf(parsed)}::jsonb)
    ON CONFLICT ("dedupeKey") DO UPDATE
      SET "deliveries" = "PaymentCallback"."deliveries" + 1, "lastReceivedAt" = CURRENT_TIMESTAMP
    RETURNING "deliveries"`;
  return rows[0].deliveries === 1;
}

async function lockedFunding(tx: Tx, reference: string): Promise<FundingAttempt | null> {
  await tx.$queryRaw`SELECT "id" FROM "FundingAttempt" WHERE "reference" = ${reference} FOR UPDATE`;
  return tx.fundingAttempt.findUnique({ where: { reference } });
}

/** By its current reference, or by the reference of an earlier, retried generation. */
async function lockedDisbursement(tx: Tx, reference: string): Promise<Disbursement | null> {
  await tx.$queryRaw`SELECT "id" FROM "Disbursement" WHERE "reference" = ${reference} OR ${reference} = ANY("previousReferences") FOR UPDATE`;
  return tx.disbursement.findFirst({ where: { OR: [{ reference }, { previousReferences: { has: reference } }] } });
}

/**
 * A callback for a generation an administrator has since retried. That
 * generation failed definitely, so a success for it contradicts the record
 * and could mean the retry would pay twice: it is raised, never applied.
 */
async function supersededGeneration(tx: Tx, row: Disbursement, success: boolean): Promise<Applied> {
  if (!success) return { outcome: "ignored", note: "A result for an earlier generation that was already handled." };
  return contradiction(tx, "A success arrived for an earlier, failed attempt of a payout that has since been retried. Check the M-Pesa portal before the retry is paid.", row.activationId);
}

function amountMismatch(expectedCents: number, reportedCents: number | null): string | null {
  if (reportedCents === expectedCents) return null;
  const reported = reportedCents === null ? "no amount" : formatCents(reportedCents);
  return `M-Pesa reported ${reported} against ${formatCents(expectedCents)} instructed.`;
}

async function contradiction(tx: Tx, note: string, activationId?: string): Promise<Applied> {
  await raiseToAdministrators(tx, { message: `A payment callback needs checking. ${note}`, activationId });
  return { outcome: "conflict", note };
}

async function applyFundingSuccess(tx: Tx, attempt: FundingAttempt, result: ParsedResult, at: Date): Promise<Applied> {
  if (attempt.status === "confirmed") return contradiction(tx, "A second success arrived for funding already confirmed. Nothing was credited.");
  if (attempt.status === "failed" && attempt.resultCode !== null) return contradiction(tx, "A success arrived for funding M-Pesa already reported as failed. Nothing was credited.");
  const mismatch = amountMismatch(attempt.amountCents, result.amountCents);
  if (mismatch) return contradiction(tx, `${mismatch} Nothing was credited.`);
  if (!result.receipt) return contradiction(tx, "A funding success arrived with no receipt. Nothing was credited.");
  const used = await tx.fundingAttempt.findUnique({ where: { receipt: result.receipt }, select: { id: true } });
  if (used) return contradiction(tx, "A funding success reused a receipt already credited. Nothing was credited.");
  await confirmFunding(tx, attempt, result.receipt, at);
  return { outcome: "applied" };
}

async function applyFundingFailure(tx: Tx, attempt: FundingAttempt, result: ParsedResult, at: Date): Promise<Applied> {
  if (attempt.status === "confirmed") return contradiction(tx, "A failure arrived for funding already confirmed. The credit stands.");
  if (attempt.status === "failed") return { outcome: "ignored", note: "Already failed." };
  await failFunding(tx, attempt, result.resultCode, result.resultDesc || `M-Pesa reported code ${result.resultCode}.`, at);
  return { outcome: "applied" };
}

async function applyStk(tx: Tx, reference: string, result: ParsedResult, at: Date): Promise<Applied> {
  const attempt = await lockedFunding(tx, reference);
  if (!attempt) return { outcome: "unknown_reference", note: "No funding attempt has this reference." };
  if (attempt.checkoutRequestId && attempt.checkoutRequestId !== result.checkoutRequestId) {
    return contradiction(tx, "A funding callback named a different M-Pesa request. Nothing changed.");
  }
  return result.resultCode === "0" ? applyFundingSuccess(tx, attempt, result, at) : applyFundingFailure(tx, attempt, result, at);
}

async function applyPayoutSuccess(tx: Tx, row: Disbursement, result: ParsedResult, at: Date): Promise<Applied> {
  const activationId = row.activationId;
  if (row.status === "paid") {
    if (row.receipt === result.receipt) return { outcome: "ignored", note: "Already paid." };
    return contradiction(tx, "A second receipt arrived for a payout already paid. Check the M-Pesa portal.", activationId);
  }
  if (row.status === "failed" && row.resultCode !== null && row.conversationId !== null) {
    return contradiction(tx, "A success arrived for a payout M-Pesa already reported as failed. Check the M-Pesa portal.", activationId);
  }
  const mismatch = amountMismatch(row.amountCents, result.amountCents);
  if (mismatch) return contradiction(tx, `${mismatch} The payout was not marked paid.`, activationId);
  if (!result.receipt) return contradiction(tx, "A payout success arrived with no receipt.", activationId);
  const used = await tx.disbursement.findUnique({ where: { receipt: result.receipt }, select: { id: true } });
  if (used) return contradiction(tx, "A payout success reused a receipt from another payout.", activationId);
  await markPaid(tx, row, { receipt: result.receipt, conversationId: result.conversationId, at });
  return { outcome: "applied" };
}

async function applyPayoutFailure(tx: Tx, row: Disbursement, resultCode: string, reason: string, conversationId: string | null, at: Date): Promise<Applied> {
  if (row.status === "paid") return contradiction(tx, "A failure arrived for a payout already paid. It stays paid; check the M-Pesa portal.", row.activationId);
  if (row.status === "failed") return { outcome: "ignored", note: "Already failed." };
  await markFailed(tx, row, { resultCode, reason, conversationId, at });
  return { outcome: "applied" };
}

async function applyB2c(tx: Tx, reference: string, result: ParsedResult, at: Date): Promise<Applied> {
  const row = await lockedDisbursement(tx, reference);
  if (!row) return { outcome: "unknown_reference", note: "No disbursement has this reference." };
  if (row.reference !== reference) return supersededGeneration(tx, row, result.resultCode === "0");
  if (row.conversationId && result.conversationId && row.conversationId !== result.conversationId) {
    return contradiction(tx, "A payout callback named a different M-Pesa conversation. Nothing changed.", row.activationId);
  }
  if (result.resultCode === "0") return applyPayoutSuccess(tx, row, result, at);
  return applyPayoutFailure(tx, row, result.resultCode, result.resultDesc || `M-Pesa reported code ${result.resultCode}.`, result.conversationId, at);
}

/** Only a final status settles anything. "Not found" and "still processing" leave the row unconfirmed. */
async function applyStatus(tx: Tx, reference: string, result: ParsedResult, at: Date): Promise<Applied> {
  const row = await lockedDisbursement(tx, reference);
  if (!row) return { outcome: "unknown_reference", note: "No disbursement has this reference." };
  if (row.reference !== reference) return supersededGeneration(tx, row, result.resultCode === "0" && result.transactionStatus === "Completed");
  if (result.originalReference && result.originalReference !== reference) {
    return contradiction(tx, "A status result described a different payout. Nothing changed.", row.activationId);
  }
  if (result.resultCode !== "0") return { outcome: "ignored", note: `Inconclusive: ${result.resultDesc}` };
  if (result.transactionStatus === "Completed") return applyPayoutSuccess(tx, row, result, at);
  if (result.transactionStatus && FINAL_FAILURE_STATUSES.has(result.transactionStatus)) {
    return applyPayoutFailure(tx, row, `status:${result.transactionStatus}`, `M-Pesa reports this payout as ${result.transactionStatus}.`, null, at);
  }
  return { outcome: "ignored", note: `Still ${result.transactionStatus ?? "unknown"}.` };
}

/** Timing out in Daraja's queue does not mean failure, so the row is checked, never resent. */
async function applyTimeout(tx: Tx, reference: string, at: Date): Promise<Applied> {
  const row = await lockedDisbursement(tx, reference);
  if (!row) return { outcome: "unknown_reference", note: "No disbursement has this reference." };
  if (row.reference !== reference) return { outcome: "ignored", note: "A timeout for an earlier generation." };
  if (row.status !== "sending" && row.status !== "sent") return { outcome: "ignored", note: `Row was ${row.status}.` };
  await tx.disbursement.update({
    where: { id: row.id },
    data: { status: "unconfirmed", nextAttemptAt: at, lockedUntil: null, lastError: "Daraja reported a queue timeout. The payout may still complete." },
  });
  return { outcome: "applied" };
}

function apply(tx: Tx, kind: CallbackKind, reference: string, result: ParsedResult | null, at: Date): Promise<Applied> {
  if (kind === "b2c-timeout") return applyTimeout(tx, reference, at);
  if (kind === "status-timeout") return Promise.resolve({ outcome: "ignored", note: "The status query timed out; the worker will ask again." });
  if (!result) return Promise.resolve({ outcome: "ignored", note: "The body could not be read." });
  if (kind === "stk") return applyStk(tx, reference, result, at);
  return kind === "b2c-result" ? applyB2c(tx, reference, result, at) : applyStatus(tx, reference, result, at);
}

export async function handleCallback(input: { kind: CallbackKind; reference: string; payload: unknown; at?: Date }): Promise<PaymentCallbackOutcome> {
  const { kind, reference } = input;
  const at = input.at ?? new Date();
  const result = parse(kind, input.payload);
  const key = dedupeKey(kind, reference, result);
  return prisma.$transaction(async (tx) => {
    if (!(await registerDelivery(tx, kind, reference, key, result))) return "duplicate";
    const applied = await apply(tx, kind, reference, result, at);
    await tx.paymentCallback.update({ where: { dedupeKey: key }, data: { outcome: applied.outcome, note: applied.note ?? null } });
    return applied.outcome;
  });
}
