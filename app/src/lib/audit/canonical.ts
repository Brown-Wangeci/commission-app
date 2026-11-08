import { createHash } from "node:crypto";

/**
 * The canonical form of an audit event (NFR-11), as specified in
 * docs/chapter5/audit-chain.md. The database computes the same form in
 * ledgerfield_audit_canonical() when it chains an event; this is the
 * independent implementation used to verify it. Any language can reproduce
 * it: a JSON object with these keys in code point order, no whitespace, every
 * value a JSON string or null, hashed with SHA-256 over its UTF-8 bytes.
 */
export const AUDIT_HASH_VERSION = "ledgerfield-audit-v1";
export const GENESIS_HASH = "0".repeat(64);

export type CanonicalEvent = {
  id: bigint | number | string;
  kind: string;
  activationId: string | null;
  fromState: string | null;
  toState: string | null;
  actorId: string | null;
  detail: string | null;
  at: Date;
};

function json(value: string | null): string {
  return value === null ? "null" : JSON.stringify(value);
}

/** UTC with milliseconds, e.g. 2026-11-08T05:43:45.558Z. */
function timestamp(at: Date): string {
  return at.toISOString();
}

export function canonicalAuditEvent(event: CanonicalEvent, sequence: bigint | number | string, previousHash: string): string {
  return (
    `{"activationId":${json(event.activationId)}` +
    `,"actorId":${json(event.actorId)}` +
    `,"at":${json(timestamp(event.at))}` +
    `,"detail":${json(event.detail)}` +
    `,"fromState":${json(event.fromState)}` +
    `,"id":${json(String(event.id))}` +
    `,"kind":${json(event.kind)}` +
    `,"previousHash":${json(previousHash)}` +
    `,"sequence":${json(String(sequence))}` +
    `,"toState":${json(event.toState)}` +
    `,"version":${json(AUDIT_HASH_VERSION)}}`
  );
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The event's hash at its chain position: SHA-256 of its canonical form. */
export function auditEventHash(event: CanonicalEvent, sequence: bigint | number | string, previousHash: string): string {
  return sha256Hex(canonicalAuditEvent(event, sequence, previousHash));
}
