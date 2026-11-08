/**
 * Writes docs/chapter5/audit-chain-vectors.json: published test vectors for
 * the canonical event form, the event hash chain and the RFC 6962 Merkle
 * tree. Any implementation in any language is correct when it reproduces
 * every expected value from the inputs. The test suite checks TypeScript,
 * PostgreSQL and Python against this file.
 *
 * Usage: npx tsx scripts/audit-vectors.ts
 */
import fs from "node:fs";
import path from "node:path";
import { auditEventHash, canonicalAuditEvent, GENESIS_HASH, type CanonicalEvent } from "../src/lib/audit/canonical";
import { inclusionProof, leafHash, merkleRoot } from "../src/lib/audit/merkle";

const EVENTS: CanonicalEvent[] = [
  { id: 1, kind: "transition", activationId: "act_001", fromState: null, toState: "submitted", actorId: "user_agent_1", detail: null, at: new Date("2026-11-08T05:43:45.558Z") },
  { id: 2, kind: "scoring_decision", activationId: "act_001", fromState: null, toState: null, actorId: null, detail: "T0 review at 41.0%", at: new Date("2026-11-08T05:43:46.001Z") },
  { id: 3, kind: "transition", activationId: "act_001", fromState: "submitted", toState: "held", actorId: null, detail: 'quote " backslash \\ newline \n tab \t', at: new Date("2026-11-08T05:43:46.002Z") },
  { id: 4, kind: "payout_authorised", activationId: "act_001", fromState: null, toState: null, actorId: "user_admin_1", detail: "KSh 279.00 × 1 — unicode é 中文 😀 control \u0001 end", at: new Date("2026-11-08T06:00:00.000Z") },
  { id: 5, kind: "audit_anchored", activationId: null, fromState: null, toState: null, actorId: null, detail: "", at: new Date("2026-11-08T07:00:00.999Z") },
];

function chain() {
  let previousHash = GENESIS_HASH;
  return EVENTS.map((event, index) => {
    const sequence = index + 1;
    const canonical = canonicalAuditEvent(event, sequence, previousHash);
    const hash = auditEventHash(event, sequence, previousHash);
    const vector = { input: { ...event, id: String(event.id), at: event.at.toISOString(), sequence: String(sequence), previousHash }, canonical, hash };
    previousHash = hash;
    return vector;
  });
}

const events = chain();
const leaves = events.map((vector) => vector.hash);
const merkle = [1, 2, 3, 4, 5].map((size) => ({ leaves: leaves.slice(0, size), root: merkleRoot(leaves.slice(0, size)) }));
const proofs = [0, 2, 4].map((index) => ({ size: 5, index, leaf: leaves[index], proof: inclusionProof(leaves, index), root: merkleRoot(leaves) }));

const out = path.resolve(__dirname, "..", "..", "docs", "chapter5", "audit-chain-vectors.json");
fs.writeFileSync(
  out,
  `${JSON.stringify({ version: "ledgerfield-audit-v1", genesisHash: GENESIS_HASH, events, merkle: { leafHashOfFirst: leafHash(leaves[0]), trees: merkle, proofs } }, null, 2)}\n`,
);
console.log(`Wrote ${out}`);
