import type { Tx } from "@/lib/db";
import { config } from "@/lib/config";
import type { DarajaOutcome, StkQueryAccepted } from "./daraja-client";
import { redactText } from "./redact";

/**
 * Status checks to Daraja (defects 10 and 11). A check "counts" only when
 * Daraja gave a result. Anything else, such as HTTP 429, a timeout, or "still
 * being processed", is a check Daraja did not answer: it is recorded, it
 * lengthens the wait, and it never uses up one of the allowed checks.
 */
export type CheckPurpose = "result_wait" | "reconcile";
export type CheckSubject = { fundingAttemptId: string } | { disbursementId: string };

const MAX_DETAIL_LENGTH = 300;
/** Doublings stop here, so a long outage is asked about every 16 minutes at most (with the default base). */
const MAX_DOUBLINGS = 4;

/** Daraja's result for an STK status check, or null if it gave none. */
export function stkAnswer(outcome: DarajaOutcome<StkQueryAccepted>): { code: string; description: string | null } | null {
  if (outcome.kind !== "accepted") return null;
  const code = outcome.body.ResultCode;
  if (code === undefined || code === null || String(code) === "") return null;
  return { code: String(code), description: typeof outcome.body.ResultDesc === "string" ? outcome.body.ResultDesc : null };
}

type Seen = { outcome: DarajaOutcome<unknown>["kind"]; httpStatus: number | null; darajaCode: string | null; detail: string | null; retryAfterSeconds: number | null };

/** What to store about one answer: the classification, status, Daraja's code, and its words after redaction. */
export function observe(outcome: DarajaOutcome<unknown>): Seen {
  const body = outcome.kind === "accepted" ? (outcome.body as { ResultCode?: unknown; ResultDesc?: unknown } | null) : null;
  const text = outcome.kind === "accepted" ? (typeof body?.ResultDesc === "string" ? body.ResultDesc : null) : outcome.reason;
  return {
    outcome: outcome.kind,
    httpStatus: outcome.httpStatus ?? null,
    darajaCode: outcome.kind === "refused" ? outcome.code : body?.ResultCode === undefined || body?.ResultCode === null ? null : String(body.ResultCode),
    detail: text ? redactText(text).slice(0, MAX_DETAIL_LENGTH) : null,
    retryAfterSeconds: outcome.retryAfterSeconds ?? null,
  };
}

/** Appends one row. The table refuses any later change. */
export async function recordStatusCheck(
  db: Tx,
  subject: CheckSubject,
  input: { purpose: CheckPurpose; outcome: DarajaOutcome<unknown>; counted: boolean; at: Date; nextCheckAt: Date | null },
): Promise<void> {
  const seen = observe(input.outcome);
  await db.paymentStatusCheck.create({
    data: { ...subject, checkedAt: input.at, purpose: input.purpose, countedAsCheck: input.counted, nextCheckAt: input.nextCheckAt, ...seen },
  });
}

/**
 * How long to wait after a check Daraja did not answer: the configured base,
 * doubled for each earlier unanswered check (up to four doublings), or the
 * Retry-After Daraja sent if that is longer. Retry-After is honoured only up
 * to a cap, so one odd header cannot park a payment.
 */
export function noAnswerDelayMs(earlierNoAnswers: number, retryAfterSeconds: number | null | undefined): number {
  const { STATUS_NO_ANSWER_RETRY_SECONDS, STATUS_RETRY_AFTER_MAX_SECONDS } = config();
  const own = STATUS_NO_ANSWER_RETRY_SECONDS * 1000 * 2 ** Math.min(earlierNoAnswers, MAX_DOUBLINGS);
  const asked = Math.min(Math.max(retryAfterSeconds ?? 0, 0), STATUS_RETRY_AFTER_MAX_SECONDS) * 1000;
  return Math.max(own, asked);
}

/** When to ask again during reconciliation: the slow interval, or Retry-After if that is longer. */
export function reconcileDelayMs(retryAfterSeconds: number | null | undefined): number {
  const { RECONCILE_INTERVAL_SECONDS, STATUS_RETRY_AFTER_MAX_SECONDS } = config();
  const asked = Math.min(Math.max(retryAfterSeconds ?? 0, 0), STATUS_RETRY_AFTER_MAX_SECONDS) * 1000;
  return Math.max(RECONCILE_INTERVAL_SECONDS * 1000, asked);
}

export function reconcileDeadline(now: Date): Date {
  return new Date(now.getTime() + config().RECONCILE_PERIOD_SECONDS * 1000);
}

/** Seconds as whole minutes, for a message. Kept here: the money files may not divide. */
export function wholeMinutes(seconds: number): number {
  return Math.round(seconds / 60);
}

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}
