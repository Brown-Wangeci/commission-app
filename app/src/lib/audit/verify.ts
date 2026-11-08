import type { AuditAnchor, AuditChain, AuditEvent } from "@prisma/client";
import type { Tx } from "@/lib/db";
import { chainReader, type ChainReader } from "@/lib/anchoring/chain";
import { scrubChainText } from "@/lib/anchoring/credentials";
import { recomputedHash } from "./chain";
import { activationEvents, anchorCovering, anchorsFor, anchorView, type AnchorView } from "./history";
import { inclusionProof, merkleRoot, verifyInclusion } from "./merkle";

/**
 * Independent verification of a submission's audit record (FR-22, C2).
 *
 * For every event: recompute its hash from the stored fields; check it links
 * to the event before it. For every anchored batch the events fall in:
 * recompute every leaf in the batch from stored fields, rebuild the Merkle
 * root and each event's inclusion proof, then ask the chain, not the
 * database, two questions: does the contract record this root, and is it the
 * root inside the transaction we say anchored the batch?
 *
 * A tampered event changes its recomputed hash, so the recomputed root is no
 * longer the one on chain. Rewriting every later stored hash does not help:
 * the on-chain root was fixed before the tampering.
 */
export type OnChainCheck =
  | { checked: true; contractAnchoredAt: string | null; transactionRoot: string | null; transactionBlock: string | null; rootOnChain: boolean; matchesTransaction: boolean }
  | { checked: false; reason: string };

export type EventCheck = {
  eventId: string;
  sequence: string | null;
  kind: string;
  storedHash: string | null;
  recomputedHash: string | null;
  hashMatches: boolean;
  linkMatches: boolean;
  proof: string[] | null;
  proofValid: boolean | null;
  anchor: AnchorView;
  batch: { storedRoot: string; recomputedRoot: string; rootMatches: boolean; onChain: OnChainCheck } | null;
  ok: boolean;
};

export type AuditVerification = {
  status: "verified" | "failed" | "partly_verified";
  checkedAt: string;
  chainId: number | null;
  contractAddress: string | null;
  events: EventCheck[];
  summary: string;
};

type Linked = AuditEvent & { chain: AuditChain | null };
type BatchResult = { leaves: Map<string, { index: number; recomputed: string }>; recomputedLeaves: string[]; recomputedRoot: string; onChain: OnChainCheck };

async function batchEvents(db: Tx, anchor: AuditAnchor): Promise<Linked[]> {
  const links = await db.auditChain.findMany({ where: { sequence: { gte: anchor.fromSequence, lte: anchor.toSequence } }, orderBy: { sequence: "asc" }, include: { event: true } });
  return links.map(({ event, ...link }) => ({ ...event, chain: link }));
}

async function onChain(reader: ChainReader | null, anchor: AuditAnchor, recomputedRoot: string): Promise<OnChainCheck> {
  if (anchor.status !== "confirmed" || !anchor.txHash) return { checked: false, reason: "This batch is not anchored yet." };
  if (!reader) return { checked: false, reason: "No blockchain connection is configured on this server." };
  if (reader.chainId !== anchor.chainId || reader.contractAddress.toLowerCase() !== anchor.contractAddress) {
    return { checked: false, reason: `This batch was anchored on chain ${anchor.chainId} at ${anchor.contractAddress}; this server reads a different chain or contract.` };
  }
  try {
    const anchoredAt = await reader.anchoredAt(recomputedRoot);
    const log = await reader.receiptLog(anchor.txHash);
    return {
      checked: true,
      contractAnchoredAt: anchoredAt > 0n ? new Date(Number(anchoredAt) * 1000).toISOString() : null,
      transactionRoot: log?.root ?? null,
      transactionBlock: log ? String(log.blockNumber) : null,
      rootOnChain: anchoredAt > 0n,
      matchesTransaction: log?.root === recomputedRoot && log.blockNumber === anchor.blockNumber,
    };
  } catch (error) {
    return { checked: false, reason: `The chain could not be read: ${scrubChainText(error instanceof Error ? error.message : String(error))}` };
  }
}

async function checkBatch(db: Tx, reader: ChainReader | null, anchor: AuditAnchor): Promise<BatchResult> {
  const events = await batchEvents(db, anchor);
  const leaves = new Map<string, { index: number; recomputed: string }>();
  const recomputedLeaves = events.map((event, index) => {
    const recomputed = recomputedHash(event, event.chain!);
    leaves.set(String(event.id), { index, recomputed });
    return recomputed;
  });
  const recomputedRoot = merkleRoot(recomputedLeaves);
  return { leaves, recomputedLeaves, recomputedRoot, onChain: await onChain(reader, anchor, recomputedRoot) };
}

async function storedHashAt(db: Tx, sequence: bigint): Promise<string | null> {
  if (sequence <= 0n) return null;
  return (await db.auditChain.findUnique({ where: { sequence }, select: { hash: true } }))?.hash ?? null;
}

function batchOk(batch: EventCheck["batch"]): boolean {
  if (!batch) return true;
  if (!batch.rootMatches) return false;
  return !batch.onChain.checked || (batch.onChain.rootOnChain && batch.onChain.matchesTransaction);
}

async function checkEvent(db: Tx, event: Linked, anchor: AuditAnchor | null, batch: BatchResult | null): Promise<EventCheck> {
  const link = event.chain;
  const recomputed = link ? recomputedHash(event, link) : null;
  const previous = link ? await storedHashAt(db, link.sequence - 1n) : null;
  const linkMatches = !!link && (link.sequence === 1n ? link.previousHash === "0".repeat(64) : link.previousHash === previous);
  const leaf = batch?.leaves.get(String(event.id)) ?? null;
  const proof = batch && leaf ? inclusionProof(batch.recomputedLeaves, leaf.index) : null;
  const proofValid = batch && leaf && proof ? verifyInclusion({ leaf: leaf.recomputed, index: leaf.index, size: batch.recomputedLeaves.length, proof, root: batch.recomputedRoot }) : null;
  const batchView = anchor && batch ? { storedRoot: anchor.root, recomputedRoot: batch.recomputedRoot, rootMatches: anchor.root === batch.recomputedRoot, onChain: batch.onChain } : null;
  const hashMatches = recomputed !== null && recomputed === link?.hash;
  return {
    eventId: String(event.id),
    sequence: link ? String(link.sequence) : null,
    kind: event.kind,
    storedHash: link?.hash ?? null,
    recomputedHash: recomputed,
    hashMatches,
    linkMatches,
    proof,
    proofValid,
    anchor: anchorView(anchor),
    batch: batchView,
    ok: hashMatches && linkMatches && proofValid !== false && batchOk(batchView),
  };
}

function summarise(events: EventCheck[]): Pick<AuditVerification, "status" | "summary"> {
  const failed = events.filter((event) => !event.ok);
  if (failed.length > 0) {
    // Name the event that was changed, if one was, rather than its innocent neighbours in the batch.
    const first = failed.find((event) => !event.hashMatches) ?? failed.find((event) => !event.linkMatches) ?? failed[0];
    const why = !first.hashMatches ? "its stored fields no longer produce its recorded hash"
      : !first.linkMatches ? "it no longer links to the event before it"
      : first.batch && !first.batch.rootMatches ? "its batch's recomputed root differs from the root recorded when it was anchored"
      : "the root recomputed from the stored events is not the root on chain";
    return { status: "failed", summary: `Verification failed at event ${first.eventId} (sequence ${first.sequence ?? "none"}): ${why}.` };
  }
  const unanchored = events.filter((event) => !event.batch || !event.batch.onChain.checked).length;
  if (unanchored > 0) return { status: "partly_verified", summary: `Every hash recomputes and links. ${unanchored} of ${events.length} event(s) could not be checked on chain yet.` };
  return { status: "verified", summary: `All ${events.length} event(s) recompute, link, and are included in roots the contract recorded on chain.` };
}

export async function verifyActivationAudit(db: Tx, activationId: string, reader: ChainReader | null = chainReader()): Promise<AuditVerification> {
  const events = await activationEvents(db, activationId);
  const anchors = await anchorsFor(db, events.flatMap((event) => (event.chain ? [event.chain.sequence] : [])));
  const batches = new Map<string, BatchResult>();
  for (const anchor of anchors) batches.set(anchor.id, await checkBatch(db, reader, anchor));
  const checks: EventCheck[] = [];
  for (const event of events) {
    const anchor = anchorCovering(anchors, event.chain?.sequence ?? null);
    checks.push(await checkEvent(db, event, anchor, anchor ? batches.get(anchor.id) ?? null : null));
  }
  return { ...summarise(checks), checkedAt: new Date().toISOString(), chainId: reader?.chainId ?? null, contractAddress: reader?.contractAddress ?? null, events: checks };
}
