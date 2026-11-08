import type { AuditChain, AuditEvent } from "@prisma/client";
import type { Tx } from "@/lib/db";
import { auditEventHash, GENESIS_HASH } from "./canonical";

/**
 * Verifying the audit hash chain (A3). Everything is recomputed from the
 * stored event fields; no stored hash is trusted until it has been
 * recomputed. The first divergence is reported, because once one link is
 * wrong every later link is suspect.
 */
export type ChainDivergence = {
  sequence: string;
  eventId: string;
  reason: "hash_mismatch" | "broken_link" | "gap" | "unchained_event";
  detail: string;
};

export type ChainReport = { ok: boolean; checked: number; head: string | null; firstDivergence: ChainDivergence | null };

type Linked = AuditEvent & { chain: AuditChain | null };

const PAGE = 1000;

/** The hash this event should have, recomputed from its fields and its recorded predecessor. */
export function recomputedHash(event: AuditEvent, link: AuditChain): string {
  return auditEventHash(event, link.sequence, link.previousHash);
}

function divergence(event: Linked, reason: ChainDivergence["reason"], detail: string): ChainDivergence {
  return { sequence: event.chain ? String(event.chain.sequence) : "none", eventId: String(event.id), reason, detail };
}

/** Checks one link against the link before it. Returns the problem, or null. */
export function checkLink(event: Linked, expectedSequence: bigint, expectedPrevious: string): ChainDivergence | null {
  const link = event.chain;
  if (!link) return divergence(event, "unchained_event", "This event has no chain link.");
  if (link.sequence !== expectedSequence) {
    return divergence(event, "gap", `Expected sequence ${expectedSequence}, found ${link.sequence}.`);
  }
  if (link.previousHash !== expectedPrevious) {
    return divergence(event, "broken_link", "Its previous hash is not the hash of the event before it.");
  }
  const recomputed = recomputedHash(event, link);
  if (recomputed !== link.hash) {
    return divergence(event, "hash_mismatch", `Stored ${link.hash}, recomputed ${recomputed} from the stored fields.`);
  }
  return null;
}

async function page(db: Tx, after: bigint): Promise<Linked[]> {
  const links = await db.auditChain.findMany({ where: { sequence: { gt: after } }, orderBy: { sequence: "asc" }, take: PAGE, include: { event: true } });
  return links.map(({ event, ...link }) => ({ ...event, chain: link }));
}

/** Walks the whole chain from the first event. Also reports events that were never chained. */
export async function verifyChain(db: Tx): Promise<ChainReport> {
  let previous = GENESIS_HASH;
  let sequence = 0n;
  let checked = 0;
  for (;;) {
    const events = await page(db, sequence);
    if (events.length === 0) break;
    for (const event of events) {
      const problem = checkLink(event, sequence + 1n, previous);
      if (problem) return { ok: false, checked, head: previous === GENESIS_HASH ? null : previous, firstDivergence: problem };
      previous = event.chain!.hash;
      sequence = event.chain!.sequence;
      checked += 1;
    }
  }
  const unchained = await db.auditEvent.findFirst({ where: { chain: null }, orderBy: { id: "asc" } });
  if (unchained) {
    return { ok: false, checked, head: previous, firstDivergence: divergence({ ...unchained, chain: null }, "unchained_event", "This event has no chain link.") };
  }
  return { ok: true, checked, head: checked === 0 ? null : previous, firstDivergence: null };
}
