import { afterEach, describe, expect, it } from "vitest";
import { parseRetryAfter } from "@/lib/payments/daraja-client";
import { noAnswerDelayMs, reconcileDelayMs, stkAnswer } from "@/lib/payments/status-checks";

/** The pure rules behind status checks (defects 10 and 12). The database behaviour is in funding.test.ts and disbursement.test.ts. */
afterEach(() => {
  delete process.env.STATUS_NO_ANSWER_RETRY_SECONDS;
  delete process.env.STATUS_RETRY_AFTER_MAX_SECONDS;
  delete process.env.RECONCILE_INTERVAL_SECONDS;
});

describe("reading Retry-After", () => {
  const now = Date.parse("2026-11-16T12:00:00Z");

  it("reads seconds, and an HTTP date relative to now", () => {
    expect(parseRetryAfter("120", now)).toBe(120);
    expect(parseRetryAfter("0", now)).toBe(0);
    expect(parseRetryAfter("Mon, 16 Nov 2026 12:05:00 GMT", now)).toBe(300);
  });

  it("never goes negative, and ignores what it cannot read", () => {
    expect(parseRetryAfter("Mon, 16 Nov 2026 11:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter("", now)).toBeNull();
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter("-5", now)).toBeNull();
  });
});

describe("how long to wait after a check Daraja did not answer", () => {
  it("starts at the base, doubles, and stops doubling after four", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map((n) => noAnswerDelayMs(n, null) / 1000)).toEqual([60, 120, 240, 480, 960, 960, 960]);
  });

  it("uses Retry-After when it is longer, up to the cap, and never less than its own wait", () => {
    expect(noAnswerDelayMs(0, 300) / 1000).toBe(300);
    expect(noAnswerDelayMs(0, 5) / 1000).toBe(60);
    expect(noAnswerDelayMs(0, 100_000) / 1000).toBe(900);
    process.env.STATUS_RETRY_AFTER_MAX_SECONDS = "120";
    expect(noAnswerDelayMs(0, 100_000) / 1000).toBe(120);
  });

  it("reconciles at the slow interval, or Retry-After if longer", () => {
    expect(reconcileDelayMs(null) / 1000).toBe(3600);
    expect(reconcileDelayMs(900) / 1000).toBe(3600);
    process.env.RECONCILE_INTERVAL_SECONDS = "600";
    expect(reconcileDelayMs(900) / 1000).toBe(900);
  });
});

describe("what counts as an answer to an STK status check", () => {
  const outcome = (kind: string, extra: object) => ({ kind, ...extra }) as never;

  it("only a result code does", () => {
    expect(stkAnswer(outcome("accepted", { body: { ResultCode: "1032", ResultDesc: "Request cancelled by user" } }))).toEqual({ code: "1032", description: "Request cancelled by user" });
    expect(stkAnswer(outcome("accepted", { body: { ResultCode: 0 } }))).toEqual({ code: "0", description: null });
  });

  it("no result code, a refusal, an unreachable Daraja and a timeout are not answers", () => {
    expect(stkAnswer(outcome("accepted", { body: {} }))).toBeNull();
    expect(stkAnswer(outcome("accepted", { body: { ResultCode: "" } }))).toBeNull();
    expect(stkAnswer(outcome("refused", { reason: "x", code: "500.001.1001", retryable: false, duplicate: false }))).toBeNull();
    expect(stkAnswer(outcome("not_delivered", { reason: "Daraja is unavailable (HTTP 429)." }))).toBeNull();
    expect(stkAnswer(outcome("unknown", { reason: "timeout" }))).toBeNull();
  });
});
