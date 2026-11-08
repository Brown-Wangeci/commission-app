import { createHash } from "node:crypto";

/**
 * Merkle trees as RFC 6962 (Certificate Transparency) section 2.1 defines
 * them, with SHA-256, so any language can recompute a root and check a proof
 * from the published standard:
 *
 *   leaf hash  = SHA-256(0x00 || leaf)
 *   node hash  = SHA-256(0x01 || left || right)
 *   MTH(D[n])  = the leaf hash when n = 1; otherwise, with k the largest power
 *                of two smaller than n, node(MTH(D[0:k]), MTH(D[k:n])).
 *
 * The 0x00 and 0x01 prefixes keep a leaf from ever passing for a node. Here
 * each leaf is an audit event's 32-byte hash. Proofs are checked with the
 * algorithm of RFC 9162 section 2.1.3.2.
 */
function sha256(...parts: Buffer[]): Buffer {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

const LEAF = Buffer.from([0x00]);
const NODE = Buffer.from([0x01]);

function toBytes(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("A Merkle leaf or node is 64 lowercase hexadecimal digits.");
  return Buffer.from(hex, "hex");
}

export function leafHash(leafHex: string): string {
  return sha256(LEAF, toBytes(leafHex)).toString("hex");
}

export function nodeHash(leftHex: string, rightHex: string): string {
  return sha256(NODE, toBytes(leftHex), toBytes(rightHex)).toString("hex");
}

function largestPowerOfTwoBelow(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** The Merkle tree hash of the leaves, in order. */
export function merkleRoot(leaves: readonly string[]): string {
  if (leaves.length === 0) throw new Error("A Merkle tree needs at least one leaf.");
  if (leaves.length === 1) return leafHash(leaves[0]);
  const k = largestPowerOfTwoBelow(leaves.length);
  return nodeHash(merkleRoot(leaves.slice(0, k)), merkleRoot(leaves.slice(k)));
}

/** The audit path for leaf m: PATH(m, D[n]) in RFC 6962 section 2.1.1. */
export function inclusionProof(leaves: readonly string[], m: number): string[] {
  if (m < 0 || m >= leaves.length) throw new Error("The leaf index is outside the tree.");
  if (leaves.length === 1) return [];
  const k = largestPowerOfTwoBelow(leaves.length);
  return m < k
    ? [...inclusionProof(leaves.slice(0, k), m), merkleRoot(leaves.slice(k))]
    : [...inclusionProof(leaves.slice(k), m - k), merkleRoot(leaves.slice(0, k))];
}

/** RFC 9162 section 2.1.3.2: does this path take leaf `index` of a `size`-leaf tree to `root`? */
export function verifyInclusion(input: { leaf: string; index: number; size: number; proof: readonly string[]; root: string }): boolean {
  if (input.index < 0 || input.index >= input.size) return false;
  let fn = input.index;
  let sn = input.size - 1;
  let r = leafHash(input.leaf);
  for (const p of input.proof) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      r = nodeHash(p, r);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      r = nodeHash(r, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && r === input.root;
}
