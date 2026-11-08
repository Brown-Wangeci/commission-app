import type { AuditAnchor, AuditChain, AuditEvent } from "@prisma/client";
import { config } from "@/lib/config";
import type { Tx } from "@/lib/db";
import { explorerBase } from "@/lib/anchoring/credentials";

/**
 * A submission's audit record (FR-22, C1): every event about it, in chain
 * order, with its hash and where it stands on chain.
 */
export type AnchorView =
  | { state: "anchored"; batchId: string; root: string; chainId: number; txHash: string; blockNumber: string; anchoredAt: string | null; txUrl: string | null }
  | { state: "queued"; batchId: string; root: string; chainId: number; txHash: string | null; lastError: string | null; escalated: boolean }
  | { state: "awaiting_batch" };

export type AuditRecordEvent = {
  eventId: string;
  sequence: string | null;
  kind: string;
  at: string;
  fromState: string | null;
  toState: string | null;
  actorId: string | null;
  detail: string | null;
  hash: string | null;
  previousHash: string | null;
  anchor: AnchorView;
};

type Linked = AuditEvent & { chain: AuditChain | null };

export async function activationEvents(db: Tx, activationId: string): Promise<Linked[]> {
  const events = await db.auditEvent.findMany({ where: { activationId }, include: { chain: true } });
  return events.sort((a, b) => Number((a.chain?.sequence ?? BigInt(Number.MAX_SAFE_INTEGER)) - (b.chain?.sequence ?? BigInt(Number.MAX_SAFE_INTEGER))));
}

/** The batches covering these sequences, keyed by batch id. */
export async function anchorsFor(db: Tx, sequences: bigint[]): Promise<AuditAnchor[]> {
  if (sequences.length === 0) return [];
  const low = sequences.reduce((a, b) => (a < b ? a : b));
  const high = sequences.reduce((a, b) => (a > b ? a : b));
  return db.auditAnchor.findMany({ where: { toSequence: { gte: low }, fromSequence: { lte: high } }, orderBy: { fromSequence: "asc" } });
}

export function anchorCovering(anchors: AuditAnchor[], sequence: bigint | null): AuditAnchor | null {
  if (sequence === null) return null;
  return anchors.find((anchor) => anchor.fromSequence <= sequence && sequence <= anchor.toSequence) ?? null;
}

export function anchorView(anchor: AuditAnchor | null): AnchorView {
  if (!anchor) return { state: "awaiting_batch" };
  if (anchor.status === "confirmed" && anchor.txHash && anchor.blockNumber !== null) {
    const base = explorerBase(anchor.chainId, config().POLYGON_EXPLORER_URL);
    return {
      state: "anchored",
      batchId: anchor.id,
      root: anchor.root,
      chainId: anchor.chainId,
      txHash: anchor.txHash,
      blockNumber: String(anchor.blockNumber),
      anchoredAt: anchor.chainTimestamp?.toISOString() ?? null,
      txUrl: base ? `${base}/tx/${anchor.txHash}` : null,
    };
  }
  return { state: "queued", batchId: anchor.id, root: anchor.root, chainId: anchor.chainId, txHash: anchor.txHash, lastError: anchor.lastError, escalated: anchor.escalatedAt !== null };
}

export async function auditRecord(db: Tx, activationId: string): Promise<AuditRecordEvent[]> {
  const events = await activationEvents(db, activationId);
  const anchors = await anchorsFor(db, events.flatMap((event) => (event.chain ? [event.chain.sequence] : [])));
  return events.map((event) => ({
    eventId: String(event.id),
    sequence: event.chain ? String(event.chain.sequence) : null,
    kind: event.kind,
    at: event.at.toISOString(),
    fromState: event.fromState,
    toState: event.toState,
    actorId: event.actorId,
    detail: event.detail,
    hash: event.chain?.hash ?? null,
    previousHash: event.chain?.previousHash ?? null,
    anchor: anchorView(anchorCovering(anchors, event.chain?.sequence ?? null)),
  }));
}
