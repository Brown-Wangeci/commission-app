import type { AuditAnchor } from "@prisma/client";
import { recordAuditEvent } from "@/lib/activations/transition";
import { checkLink } from "@/lib/audit/chain";
import { GENESIS_HASH } from "@/lib/audit/canonical";
import { merkleRoot } from "@/lib/audit/merkle";
import { config } from "@/lib/config";
import { prisma } from "@/lib/db";
import { backoffMs, raiseToAdministrators } from "@/lib/payments/attention";
import { chainWriter, type AnchorLog, type ChainWriter } from "./chain";
import { scrubChainText } from "./credentials";

/**
 * The anchoring queue (FR-21, IR-04, IR-05). Nothing here runs inside a user
 * action: the scheduler and the cron route call runDueAnchoring(), so an
 * unreachable chain can never hold up a submission or a payout. Events go on
 * being recorded and chained; they wait in the next batch.
 *
 * A batch is a contiguous range of the chain with its RFC 6962 Merkle root,
 * fixed once created. One batch is in flight at a time, oldest first, so the
 * anchors cover the history in order. Sending twice is harmless: the contract
 * refuses a root it already holds, and every attempt first asks the chain
 * whether the root is already there.
 */
export type AnchorRunSummary = { skipped: boolean; created: number; confirmed: number; failed: number; waiting: string | null };

async function lastAnchor(): Promise<AuditAnchor | null> {
  return prisma.auditAnchor.findFirst({ orderBy: { toSequence: "desc" } });
}

async function openAnchor(): Promise<AuditAnchor | null> {
  return prisma.auditAnchor.findFirst({ where: { status: { not: "confirmed" } }, orderBy: { fromSequence: "asc" } });
}

/** Due when the interval has passed, or at once while working off a backlog (the last batch was full). */
function batchDue(last: AuditAnchor | null, now: Date): boolean {
  if (!last) return true;
  if (last.leafCount >= config().ANCHOR_MAX_LEAVES) return true;
  return now.getTime() - last.createdAt.getTime() >= config().ANCHOR_INTERVAL_SECONDS * 1000;
}

/**
 * Re-checks every link in the range from the stored fields before anchoring
 * it, so a tampered log is never given a fresh anchor. Returns the hashes.
 */
async function verifiedRange(from: bigint, to: bigint): Promise<string[]> {
  const links = await prisma.auditChain.findMany({ where: { sequence: { gte: from, lte: to } }, orderBy: { sequence: "asc" }, include: { event: true } });
  let previous = from === 1n ? GENESIS_HASH : links[0]?.previousHash ?? GENESIS_HASH;
  let expected = from;
  for (const { event, ...link } of links) {
    const problem = checkLink({ ...event, chain: link }, expected, previous);
    if (problem) throw new Error(`The audit chain is broken at sequence ${problem.sequence} (${problem.reason}); it was not anchored.`);
    previous = link.hash;
    expected += 1n;
  }
  return links.map((link) => link.hash);
}

async function createBatch(chain: ChainWriter, now: Date): Promise<AuditAnchor | null> {
  const last = await lastAnchor();
  if (!batchDue(last, now)) return null;
  const head = await prisma.auditChain.findFirst({ orderBy: { sequence: "desc" }, select: { sequence: true } });
  const from = (last?.toSequence ?? 0n) + 1n;
  if (!head || head.sequence < from) return null;
  const limit = from + BigInt(config().ANCHOR_MAX_LEAVES) - 1n;
  const to = head.sequence < limit ? head.sequence : limit;
  const leaves = await verifiedRange(from, to);
  return prisma.auditAnchor.create({
    data: {
      fromSequence: from,
      toSequence: to,
      leafCount: leaves.length,
      root: merkleRoot(leaves),
      chainId: chain.chainId,
      contractAddress: chain.contractAddress.toLowerCase(),
      nextAttemptAt: now,
      createdAt: now,
    },
  });
}

async function claim(anchor: AuditAnchor, now: Date): Promise<AuditAnchor | null> {
  const lease = new Date(now.getTime() + config().SCHEDULER_LEASE_SECONDS * 1000);
  const claimed = await prisma.auditAnchor.updateMany({
    where: { id: anchor.id, status: { not: "confirmed" }, escalatedAt: null, nextAttemptAt: { lte: now }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    data: { lockedUntil: lease, attempts: { increment: 1 } },
  });
  return claimed.count === 0 ? null : prisma.auditAnchor.findUnique({ where: { id: anchor.id } });
}

async function confirm(anchor: AuditAnchor, log: AnchorLog, now: Date): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.auditAnchor.update({
      where: { id: anchor.id },
      data: {
        status: "confirmed",
        txHash: log.txHash,
        blockNumber: log.blockNumber,
        chainTimestamp: new Date(Number(log.timestamp) * 1000),
        submitter: log.submitter,
        confirmedAt: now,
        lockedUntil: null,
        lastError: null,
        escalatedAt: null,
      },
    });
    await recordAuditEvent(tx, {
      kind: "audit_anchored",
      detail: `Audit events ${anchor.fromSequence} to ${anchor.toSequence} anchored on chain ${anchor.chainId}: root ${anchor.root}, transaction ${log.txHash}, block ${log.blockNumber}.`,
      at: now,
    });
  });
}

/** The chain already holds this root: find the transaction that put it there. */
async function alreadyAnchored(chain: ChainWriter, anchor: AuditAnchor): Promise<AnchorLog | null> {
  if (anchor.txHash) {
    const log = await chain.receiptLog(anchor.txHash);
    if (log && log.root === anchor.root) return log;
  }
  return chain.findAnchorLog(anchor.root, anchor.searchFromBlock ?? 0n);
}

type Attempt = "confirmed" | "waiting";

async function send(chain: ChainWriter, anchor: AuditAnchor, now: Date): Promise<Attempt> {
  if ((await chain.anchoredAt(anchor.root)) > 0n) {
    const log = await alreadyAnchored(chain, anchor);
    if (!log) throw new Error("The root is on chain but its transaction has not been found yet.");
    await confirm(anchor, log, now);
    return "confirmed";
  }
  const searchFromBlock = anchor.searchFromBlock ?? (await chain.blockNumber());
  const txHash = await chain.submit(anchor.root);
  await prisma.auditAnchor.update({ where: { id: anchor.id }, data: { status: "submitted", txHash, searchFromBlock, submitter: chain.submitter, submittedAt: now } });
  const receipt = await chain.waitForReceipt(txHash, config().ANCHOR_RECEIPT_TIMEOUT_MS);
  if (!receipt) return waitForReceipt(anchor, now);
  if (receipt.status === "success") {
    const log = await chain.receiptLog(txHash);
    if (!log) throw new Error("The transaction succeeded but carried no anchor event.");
    await confirm(anchor, log, now);
    return "confirmed";
  }
  // Reverted: most likely another transaction anchored the root first.
  if ((await chain.anchoredAt(anchor.root)) > 0n) {
    const log = await chain.findAnchorLog(anchor.root, searchFromBlock);
    if (log) {
      await confirm(anchor, log, now);
      return "confirmed";
    }
  }
  throw new Error(`The anchoring transaction ${txHash} reverted.`);
}

/** Sent, receipt not seen yet. Not a failure: the next run asks the chain first. */
async function waitForReceipt(anchor: AuditAnchor, now: Date): Promise<Attempt> {
  const nextAttemptAt = new Date(now.getTime() + config().ANCHOR_RETRY_BASE_SECONDS * 1000);
  await prisma.auditAnchor.update({ where: { id: anchor.id }, data: { lockedUntil: null, nextAttemptAt, lastError: "Sent; the receipt had not arrived yet." } });
  return "waiting";
}

async function retryOrEscalate(anchor: AuditAnchor, reason: string, now: Date): Promise<void> {
  const { ANCHOR_MAX_ATTEMPTS, ANCHOR_RETRY_BASE_SECONDS } = config();
  if (anchor.attempts < ANCHOR_MAX_ATTEMPTS) {
    const nextAttemptAt = new Date(now.getTime() + backoffMs(ANCHOR_RETRY_BASE_SECONDS, anchor.attempts));
    await prisma.auditAnchor.update({ where: { id: anchor.id }, data: { lockedUntil: null, nextAttemptAt, lastError: reason } });
    return;
  }
  await prisma.$transaction(async (tx) => {
    const moved = await tx.auditAnchor.updateMany({ where: { id: anchor.id, escalatedAt: null }, data: { lockedUntil: null, escalatedAt: now, lastError: reason } });
    if (moved.count === 0) return;
    await raiseToAdministrators(tx, {
      message: `Anchoring audit events ${anchor.fromSequence} to ${anchor.toSequence} failed ${anchor.attempts} times: ${reason} Events are still recorded and chained; they will be anchored once the problem is fixed and the batch is retried from the Audit log page.`,
    });
  });
}

async function attempt(chain: ChainWriter, anchor: AuditAnchor, now: Date): Promise<Attempt | "failed" | "not_claimed"> {
  const claimed = await claim(anchor, now);
  if (!claimed) return "not_claimed";
  try {
    return await send(chain, claimed, now);
  } catch (error) {
    await retryOrEscalate(claimed, scrubChainText(error instanceof Error ? error.message : String(error)), now);
    return "failed";
  }
}

/**
 * Works the queue once: finishes the batch in flight, then, if it confirmed
 * and the interval has passed, cuts and sends the next. Waits, using no
 * attempts, while the chain is not configured.
 */
export async function runDueAnchoring(now: Date = new Date()): Promise<AnchorRunSummary> {
  const summary: AnchorRunSummary = { skipped: false, created: 0, confirmed: 0, failed: 0, waiting: null };
  const chain = chainWriter();
  if (!chain) return { ...summary, skipped: true };
  for (let round = 0; round < 2; round += 1) {
    let anchor = await openAnchor();
    if (anchor?.escalatedAt) return { ...summary, waiting: `Batch ${anchor.fromSequence}-${anchor.toSequence} needs an administrator.` };
    if (!anchor) {
      try {
        anchor = await createBatch(chain, now);
      } catch (error) {
        await raiseToAdministrators(prisma, { message: scrubChainText(error instanceof Error ? error.message : String(error)) });
        return { ...summary, failed: summary.failed + 1, waiting: "The chain failed verification before anchoring." };
      }
      if (!anchor) return summary;
      summary.created += 1;
    }
    const outcome = await attempt(chain, anchor, now);
    if (outcome === "confirmed") summary.confirmed += 1;
    else {
      if (outcome === "failed") summary.failed += 1;
      return { ...summary, waiting: outcome === "waiting" ? "Receipt not yet seen." : summary.waiting };
    }
  }
  return summary;
}

/** An administrator sends an escalated batch round again (D2-style, as payouts). */
export async function retryAnchor(anchorId: string, actorId: string, now: Date = new Date()): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const moved = await tx.auditAnchor.updateMany({
      where: { id: anchorId, status: { not: "confirmed" }, escalatedAt: { not: null } },
      data: { escalatedAt: null, attempts: 0, nextAttemptAt: now, lockedUntil: null },
    });
    if (moved.count === 0) return false;
    await recordAuditEvent(tx, { kind: "anchor_retried", actorId, detail: `Anchoring batch ${anchorId} sent round again by an administrator.`, at: now });
    return true;
  });
}
