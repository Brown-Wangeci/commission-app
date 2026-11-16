/**
 * Arms reconciliation (defect 12) on payment rows made before the feature
 * existed. Those rows have no deadline, so the worker never asks Daraja about
 * them. This sets one, by hand, the way the app itself would have.
 *
 *   show                     prints each candidate row's state (no write).
 *   checks                   prints every PaymentStatusCheck row (what Daraja answered).
 *   arm <id> [<id> ...]      sets reconcileUntil = now + RECONCILE_PERIOD_SECONDS
 *                            and nextAttemptAt = now on the named rows. Each row
 *                            must be a funding attempt that is failed with no
 *                            result code, or a disbursement that is unconfirmed
 *                            and already raised. Anything else is refused.
 *
 * It sends nothing to Daraja and never credits or pays. The scheduled payments
 * run does the asking, and records every answer in PaymentStatusCheck.
 *
 * Usage, from app/ (reads the pulled hosted settings; prints no secret):
 *   node --env-file=.env.hosted node_modules/tsx/dist/cli.mjs scripts/arm-reconciliation.ts show
 */
import { PrismaClient } from "@prisma/client";
import { config } from "../src/lib/config";
import { reconcileDeadline } from "../src/lib/payments/status-checks";

const prisma = new PrismaClient();

async function show(): Promise<void> {
  const funding = await prisma.fundingAttempt.findMany({
    where: { status: { in: ["failed", "pending"] } },
    select: { id: true, status: true, amountCents: true, createdAt: true, resultCode: true, escalatedAt: true, reconcileUntil: true, nextAttemptAt: true, queryCount: true, noAnswerCount: true, receipt: true, checkoutRequestId: true },
    orderBy: { createdAt: "asc" },
  });
  const payouts = await prisma.disbursement.findMany({
    where: { status: { in: ["unconfirmed", "sent"] } },
    select: { id: true, status: true, amountCents: true, createdAt: true, resultCode: true, escalatedAt: true, reconcileUntil: true, nextAttemptAt: true, queryCount: true, noAnswerCount: true, receipt: true, conversationId: true },
    orderBy: { createdAt: "asc" },
  });
  const checks = await prisma.paymentStatusCheck.count();
  const flag = (value: string | null) => (value ? "present" : "none");
  console.log(JSON.stringify({ paymentStatusCheckRows: checks, funding: funding.map((r) => ({ ...r, receipt: flag(r.receipt), checkoutRequestId: flag(r.checkoutRequestId) })), payouts: payouts.map((r) => ({ ...r, receipt: flag(r.receipt), conversationId: flag(r.conversationId) })) }, null, 2));
}

async function checks(): Promise<void> {
  const rows = await prisma.paymentStatusCheck.findMany({ orderBy: { checkedAt: "asc" } });
  console.log(JSON.stringify(rows, null, 2));
}

async function armOne(id: string, now: Date): Promise<string> {
  const data = { reconcileUntil: reconcileDeadline(now), nextAttemptAt: now };
  const funding = await prisma.fundingAttempt.updateMany({ where: { id, status: "failed", resultCode: null, escalatedAt: null, reconcileUntil: null, checkoutRequestId: { not: null } }, data });
  if (funding.count > 0) return `${id}: funding attempt armed until ${data.reconcileUntil.toISOString()}`;
  const payout = await prisma.disbursement.updateMany({ where: { id, status: "unconfirmed", escalatedAt: { not: null }, reconcileUntil: null }, data });
  if (payout.count > 0) return `${id}: payout armed until ${data.reconcileUntil.toISOString()}`;
  return `${id}: REFUSED, not an unarmed failed funding attempt or raised unconfirmed payout`;
}

async function main(): Promise<void> {
  const [command, ...ids] = process.argv.slice(2);
  config();
  if (command === "show") return show();
  if (command === "checks") return checks();
  if (command === "arm" && ids.length > 0) {
    const now = new Date();
    for (const id of ids) console.log(await armOne(id, now));
    return;
  }
  console.error("Usage: show | arm <id> [<id> ...]");
  process.exitCode = 1;
}

main().finally(() => prisma.$disconnect());
