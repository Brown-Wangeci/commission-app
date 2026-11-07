import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { clientEscrow } from "@/lib/escrow/client";
import { checkFunding, listFundingAttempts, sendFunding, startFunding } from "@/lib/payments/funding";
import { runDuePayments } from "@/lib/payments/worker";
import { deliver, stkCancelled, stkSuccess } from "./helpers/daraja-payloads";
import { resetDatabase } from "./helpers/db";
import { createClient } from "./helpers/factories";
import { PATHS, startFakeDaraja, type FakeDaraja } from "./helpers/fake-daraja";

const AMOUNT = 500_000;
const PHONE = "0712345678";

let daraja: FakeDaraja;
let client: Awaited<ReturnType<typeof createClient>>;

beforeAll(async () => {
  daraja = await startFakeDaraja();
  process.env.MPESA_BASE_URL = daraja.url;
});
afterAll(() => daraja.close());
beforeEach(async () => {
  await resetDatabase();
  daraja.reset();
  process.env.MPESA_TIMEOUT_MS = "1000";
  client = await createClient();
});

function start(overrides: { amountCents?: number; at?: Date } = {}) {
  return startFunding({ clientId: client.id, actorId: client.userId, amountCents: AMOUNT, payerMsisdn: PHONE, ...overrides });
}

async function balance(): Promise<number> {
  return (await clientEscrow(prisma, client.id)).depositedCents;
}

async function attemptRow(id: string) {
  return prisma.fundingAttempt.findUniqueOrThrow({ where: { id } });
}

describe("starting a funding attempt (A1, A2)", () => {
  it("sends one STK Push as Daraja documents it, and credits nothing", async () => {
    const attempt = await start();
    expect(attempt).toMatchObject({ status: "pending", amountCents: AMOUNT, sendCount: 1 });
    expect(attempt.checkoutRequestId).toMatch(/^ws_CO_FAKE/);
    const [push] = daraja.callsTo(PATHS.stk);
    expect(push.authorization).toBe("Bearer fake-token");
    expect(push.body).toMatchObject({
      BusinessShortCode: 174379, TransactionType: "CustomerPayBillOnline", Amount: "5000", PartyA: "254712345678",
      PartyB: "174379", PhoneNumber: "254712345678", TransactionDesc: "Escrow fund",
    });
    expect(String(push.body.AccountReference).length).toBeLessThanOrEqual(12);
    expect(String(push.body.TransactionDesc).length).toBeLessThanOrEqual(13);
    expect(String(push.body.CallBackURL)).toMatch(/^https:\/\/callbacks\.test\/api\/payments\/callback\/stk\/[0-9a-f]{32}\/[0-9a-f]{64}$/);
    expect(await balance()).toBe(0);
    expect(await prisma.escrowDeposit.count()).toBe(0);
  });

  it("builds the password from shortcode, passkey and the same timestamp it sends", async () => {
    await start({ at: new Date("2026-11-07T09:24:08.000Z") });
    const [push] = daraja.callsTo(PATHS.stk);
    expect(push.body.Timestamp).toBe("20261107122408");
    expect(Buffer.from(String(push.body.Password), "base64").toString()).toBe("174379test-stk-passkey20261107122408");
  });

  it("refuses an amount M-Pesa cannot take, with no attempt and no call", async () => {
    await expect(start({ amountCents: 10_050 })).rejects.toMatchObject({ status: 422 });
    await expect(start({ amountCents: 50 })).rejects.toMatchObject({ status: 422 });
    expect(await prisma.fundingAttempt.count()).toBe(0);
    expect(daraja.callsTo(PATHS.stk)).toHaveLength(0);
  });

  it("refuses when credentials are not set, charging nothing", async () => {
    const saved = process.env.MPESA_CALLBACK_BASE_URL;
    delete process.env.MPESA_CALLBACK_BASE_URL;
    await expect(start()).rejects.toMatchObject({ status: 503, code: "payments_unavailable" });
    process.env.MPESA_CALLBACK_BASE_URL = saved;
    expect(await prisma.fundingAttempt.count()).toBe(0);
  });

  it("reuses one access token across calls", async () => {
    await start();
    await start();
    expect(daraja.callsTo(PATHS.stk)).toHaveLength(2);
    expect(daraja.callsTo(PATHS.token).length).toBeLessThanOrEqual(1);
  });
});

describe("the callback credits, and only the callback (A2, C2, C3)", () => {
  it("credits the balance once on a verified success", async () => {
    const attempt = await start();
    const response = await deliver("stk", attempt.reference, stkSuccess(attempt.checkoutRequestId!, 5000));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ResultCode: 0, ResultDesc: "Accepted" });
    expect(await attemptRow(attempt.id)).toMatchObject({ status: "confirmed", receipt: "NLJ7RT61SV", resultCode: "0" });
    expect(await balance()).toBe(AMOUNT);
    const deposit = await prisma.escrowDeposit.findFirstOrThrow();
    expect(deposit).toMatchObject({ fundingAttemptId: attempt.id, amountCents: AMOUNT, clientId: client.id });
    expect(await prisma.notification.count({ where: { userId: client.userId, kind: "funding_confirmed" } })).toBe(1);
  });

  it("credits once when the same callback is replayed many times", async () => {
    const attempt = await start();
    const body = stkSuccess(attempt.checkoutRequestId!, 5000);
    for (let i = 0; i < 10; i += 1) expect((await deliver("stk", attempt.reference, body)).status).toBe(200);
    expect(await prisma.escrowDeposit.count()).toBe(1);
    expect(await balance()).toBe(AMOUNT);
    expect(await prisma.paymentCallback.findFirstOrThrow()).toMatchObject({ deliveries: 10, outcome: "applied" });
    expect(await prisma.notification.count({ where: { kind: "funding_confirmed" } })).toBe(1);
  });

  it("credits once when the same callback arrives concurrently", async () => {
    const attempt = await start();
    const body = stkSuccess(attempt.checkoutRequestId!, 5000);
    const responses = await Promise.all(Array.from({ length: 8 }, () => deliver("stk", attempt.reference, body)));
    expect(responses.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(await prisma.escrowDeposit.count()).toBe(1);
    expect(await balance()).toBe(AMOUNT);
  });

  it("records a cancelled payment as failed, with the reason, and credits nothing", async () => {
    const attempt = await start();
    await deliver("stk", attempt.reference, stkCancelled(attempt.checkoutRequestId!));
    expect(await attemptRow(attempt.id)).toMatchObject({ status: "failed", resultCode: "1032", failureReason: "Request cancelled by user" });
    expect(await balance()).toBe(0);
    expect(await prisma.notification.count({ where: { userId: client.userId, kind: "funding_failed" } })).toBe(1);
  });

  it("does not credit when M-Pesa reports a different amount", async () => {
    const attempt = await start();
    await deliver("stk", attempt.reference, stkSuccess(attempt.checkoutRequestId!, 4999));
    expect(await attemptRow(attempt.id)).toMatchObject({ status: "pending" });
    expect(await balance()).toBe(0);
    expect(await prisma.paymentCallback.findFirstOrThrow()).toMatchObject({ outcome: "conflict" });
  });

  it("does not credit a success with no receipt", async () => {
    const attempt = await start();
    const body = stkSuccess(attempt.checkoutRequestId!, 5000);
    body.Body.stkCallback.CallbackMetadata.Item = body.Body.stkCallback.CallbackMetadata.Item.filter((item) => item.Name !== "MpesaReceiptNumber");
    await deliver("stk", attempt.reference, body);
    expect(await balance()).toBe(0);
    expect((await attemptRow(attempt.id)).status).toBe("pending");
  });

  it("will not let one receipt credit two attempts", async () => {
    const first = await start();
    const second = await start();
    await deliver("stk", first.reference, stkSuccess(first.checkoutRequestId!, 5000, "SAMERECEIPT"));
    await deliver("stk", second.reference, stkSuccess(second.checkoutRequestId!, 5000, "SAMERECEIPT"));
    expect(await prisma.escrowDeposit.count()).toBe(1);
    expect((await attemptRow(second.id)).status).toBe("pending");
  });

  it("ignores a callback naming a different M-Pesa request", async () => {
    const attempt = await start();
    await deliver("stk", attempt.reference, stkSuccess("ws_CO_SOMEONE_ELSE", 5000));
    expect((await attemptRow(attempt.id)).status).toBe("pending");
    expect(await balance()).toBe(0);
  });

  it("keeps the credit when a failure arrives after a success", async () => {
    const attempt = await start();
    await deliver("stk", attempt.reference, stkSuccess(attempt.checkoutRequestId!, 5000));
    await deliver("stk", attempt.reference, stkCancelled(attempt.checkoutRequestId!));
    expect((await attemptRow(attempt.id)).status).toBe("confirmed");
    expect(await balance()).toBe(AMOUNT);
    expect(await prisma.paymentCallback.count({ where: { outcome: "conflict" } })).toBe(1);
  });

  it("does not credit a success arriving after M-Pesa itself reported failure, and raises it", async () => {
    const attempt = await start();
    await deliver("stk", attempt.reference, stkCancelled(attempt.checkoutRequestId!));
    await deliver("stk", attempt.reference, stkSuccess(attempt.checkoutRequestId!, 5000));
    expect((await attemptRow(attempt.id)).status).toBe("failed");
    expect(await balance()).toBe(0);
    expect(await prisma.paymentCallback.count({ where: { outcome: "conflict" } })).toBe(1);
  });

  it("records a callback for an unknown reference, changes nothing, and acknowledges it", async () => {
    const response = await deliver("stk", "a".repeat(32), stkSuccess("ws_CO_UNKNOWN", 5000));
    expect(response.status).toBe(200);
    expect(await prisma.paymentCallback.findFirstOrThrow()).toMatchObject({ outcome: "unknown_reference", reference: "a".repeat(32) });
    expect(await prisma.escrowDeposit.count()).toBe(0);
  });

  it("stores no phone number from a callback", async () => {
    const attempt = await start();
    await deliver("stk", attempt.reference, stkSuccess(attempt.checkoutRequestId!, 5000));
    const row = await prisma.paymentCallback.findFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain("254708374149");
  });
});

describe("the database refuses a credit with no confirmed payment (A2)", () => {
  async function insertDeposit(fundingAttemptId: string | null, amountCents = AMOUNT, clientId = client.id) {
    await prisma.escrowDeposit.create({ data: { clientId, amountCents, createdById: client.userId, fundingAttemptId } });
  }

  it("refuses a deposit with no attempt, or on one that is not confirmed", async () => {
    await expect(insertDeposit(null)).rejects.toThrow(/needs a confirmed funding attempt/);
    const attempt = await start();
    await expect(insertDeposit(attempt.id)).rejects.toThrow(/needs a confirmed funding attempt/);
  });

  it("refuses a second deposit, a wrong amount and another client's attempt", async () => {
    const attempt = await start();
    await deliver("stk", attempt.reference, stkSuccess(attempt.checkoutRequestId!, 5000));
    await expect(insertDeposit(attempt.id)).rejects.toThrow(/Unique constraint/);
    const second = await start();
    await deliver("stk", second.reference, stkSuccess(second.checkoutRequestId!, 5000, "OTHERRECEIPT"));
    await prisma.escrowDeposit.deleteMany({ where: { fundingAttemptId: second.id } });
    await expect(insertDeposit(second.id, AMOUNT + 100)).rejects.toThrow(/must credit exactly/);
    const other = await createClient();
    await expect(insertDeposit(second.id, AMOUNT, other.id)).rejects.toThrow(/must credit exactly/);
  });

  it("will not take a confirmed attempt back, change its amount, or delete it", async () => {
    const attempt = await start();
    await deliver("stk", attempt.reference, stkSuccess(attempt.checkoutRequestId!, 5000));
    await expect(prisma.fundingAttempt.update({ where: { id: attempt.id }, data: { status: "failed" } })).rejects.toThrow(/cannot move from confirmed/);
    await expect(prisma.fundingAttempt.update({ where: { id: attempt.id }, data: { amountCents: 1 } })).rejects.toThrow(/instruction cannot change/);
    await expect(prisma.fundingAttempt.delete({ where: { id: attempt.id } })).rejects.toThrow();
  });
});

describe("when Daraja is unavailable or errors (D1)", () => {
  const busy = { status: 500, body: { errorCode: "500.003.02", errorMessage: "System is busy. Please try again in few minutes." } };

  it("keeps the attempt, tells the client, and retries with growing delays up to the limit", async () => {
    daraja.setHandler((call) => (call.path === PATHS.stk ? busy : undefined));
    const t0 = new Date("2026-11-07T09:00:00.000Z");
    const attempt = await start({ at: t0 });
    const first = await attemptRow(attempt.id);
    expect(first).toMatchObject({ status: "queued", sendCount: 1 });
    expect(first.lastError).toMatch(/busy/i);
    expect(first.nextAttemptAt.getTime() - t0.getTime()).toBe(15_000);
    await sendFunding(attempt.id, first.nextAttemptAt);
    const second = await attemptRow(attempt.id);
    expect(second.nextAttemptAt.getTime() - first.nextAttemptAt.getTime()).toBe(30_000);
    await sendFunding(attempt.id, second.nextAttemptAt);
    expect(await attemptRow(attempt.id)).toMatchObject({ status: "failed", sendCount: 3 });
    expect((await attemptRow(attempt.id)).failureReason).toMatch(/after 3 tries/);
    expect(daraja.callsTo(PATHS.stk)).toHaveLength(3);
  });

  it("does not send before the retry is due", async () => {
    daraja.setHandler((call) => (call.path === PATHS.stk ? busy : undefined));
    const t0 = new Date("2026-11-07T09:00:00.000Z");
    const attempt = await start({ at: t0 });
    expect(await sendFunding(attempt.id, new Date(t0.getTime() + 1000))).toBe("not_claimed");
    expect(daraja.callsTo(PATHS.stk)).toHaveLength(1);
  });

  it("fails at once when Daraja refuses for good", async () => {
    daraja.setHandler((call) => (call.path === PATHS.stk ? { status: 400, body: { errorCode: "400.002.02", errorMessage: "Bad Request - Invalid PhoneNumber" } } : undefined));
    const attempt = await start();
    expect(attempt).toMatchObject({ status: "failed", sendCount: 1, failureReason: "Bad Request - Invalid PhoneNumber" });
  });

  it("never sends again after a timeout, because the prompt may be on the phone, and still credits by its URL", async () => {
    process.env.MPESA_TIMEOUT_MS = "100";
    daraja.setHandler((call) => (call.path === PATHS.stk ? { status: 200, body: {}, delayMs: 400 } : undefined));
    const t0 = new Date("2026-11-07T09:00:00.000Z");
    const attempt = await start({ at: t0 });
    expect(attempt).toMatchObject({ status: "pending", checkoutRequestId: null });
    await runDuePayments(new Date(t0.getTime() + 60_000));
    expect(daraja.callsTo(PATHS.stk)).toHaveLength(1);
    await deliver("stk", attempt.reference, stkSuccess("ws_CO_ONLY_DARAJA_KNEW", 5000));
    expect((await attemptRow(attempt.id)).status).toBe("confirmed");
    expect(await balance()).toBe(AMOUNT);
  });

  it("does not send twice when two workers race", async () => {
    daraja.setHandler((call) => (call.path === PATHS.stk && daraja.callsTo(PATHS.stk).length === 1 ? busy : undefined));
    const t0 = new Date("2026-11-07T09:00:00.000Z");
    const attempt = await start({ at: t0 });
    const due = (await attemptRow(attempt.id)).nextAttemptAt;
    const outcomes = await Promise.all([sendFunding(attempt.id, due), sendFunding(attempt.id, due), sendFunding(attempt.id, due)]);
    expect(outcomes.filter((outcome) => outcome === "not_claimed")).toHaveLength(2);
    expect(daraja.callsTo(PATHS.stk)).toHaveLength(2);
  });

  it("treats a worker that stopped mid-send as unknown, never as sendable", async () => {
    const t0 = new Date("2026-11-07T09:00:00.000Z");
    const attempt = await start({ at: t0 });
    await prisma.$executeRaw`UPDATE "FundingAttempt" SET "status" = 'failed' WHERE "id" = ${attempt.id}`;
    const stuck = await prisma.fundingAttempt.create({
      data: { reference: "b".repeat(32), clientId: client.id, requestedById: client.userId, amountCents: AMOUNT, payerMsisdn: PHONE, status: "sending", sendCount: 1, nextAttemptAt: t0, lockedUntil: t0 },
    });
    const calls = daraja.callsTo(PATHS.stk).length;
    await runDuePayments(new Date(t0.getTime() + 1000));
    expect((await attemptRow(stuck.id)).status).not.toBe("queued");
    expect(daraja.callsTo(PATHS.stk)).toHaveLength(calls);
  });
});

describe("a result that never arrives", () => {
  const t0 = new Date("2026-11-07T09:00:00.000Z");
  const overdue = new Date(t0.getTime() + 181_000);

  it("marks the attempt failed when the status check says it failed", async () => {
    const attempt = await start({ at: t0 });
    await checkFunding(attempt.id, overdue);
    expect(await attemptRow(attempt.id)).toMatchObject({ status: "failed", failureReason: "Request cancelled by user", resultCode: null });
    expect(daraja.callsTo(PATHS.stkQuery)).toHaveLength(1);
  });

  it("never credits on a status check, and raises it instead", async () => {
    daraja.setHandler((call) => (call.path === PATHS.stkQuery ? { status: 200, body: { ResponseCode: "0", ResultCode: "0", ResultDesc: "The service request is processed successfully." } } : undefined));
    const attempt = await start({ at: t0 });
    await checkFunding(attempt.id, overdue);
    const row = await attemptRow(attempt.id);
    expect(row.status).toBe("pending");
    expect(row.escalatedAt).not.toBeNull();
    expect(await balance()).toBe(0);
  });

  it("gives up after the check limit, and a late callback can still credit", async () => {
    daraja.setHandler((call) => (call.path === PATHS.stkQuery ? { status: 500, body: { errorCode: "500.001.1001", errorMessage: "The transaction is being processed" } } : undefined));
    const attempt = await start({ at: t0 });
    let now = overdue;
    for (let i = 0; i < 3; i += 1) {
      await checkFunding(attempt.id, now);
      now = new Date((await attemptRow(attempt.id)).nextAttemptAt.getTime() + 1);
    }
    expect(await attemptRow(attempt.id)).toMatchObject({ status: "failed", resultCode: null });
    await deliver("stk", attempt.reference, stkSuccess(attempt.checkoutRequestId!, 5000));
    expect((await attemptRow(attempt.id)).status).toBe("confirmed");
    expect(await balance()).toBe(AMOUNT);
  });
});

describe("what the client sees (A3)", () => {
  it("lists pending, confirmed and failed attempts for that client only", async () => {
    const pending = await start();
    const confirmed = await start();
    const failed = await start();
    await deliver("stk", confirmed.reference, stkSuccess(confirmed.checkoutRequestId!, 5000));
    await deliver("stk", failed.reference, stkCancelled(failed.checkoutRequestId!));
    const rows = await listFundingAttempts(prisma, client.id);
    expect(Object.fromEntries(rows.map((row) => [row.id, row.status]))).toEqual({ [pending.id]: "pending", [confirmed.id]: "confirmed", [failed.id]: "failed" });
    expect(await listFundingAttempts(prisma, (await createClient()).id)).toEqual([]);
  });
});
