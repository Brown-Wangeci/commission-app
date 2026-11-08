import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { auditEventHash, canonicalAuditEvent, GENESIS_HASH } from "@/lib/audit/canonical";
import { verifyChain } from "@/lib/audit/chain";
import { inclusionProof, leafHash, merkleRoot, nodeHash, verifyInclusion } from "@/lib/audit/merkle";
import { recordAuditEvent } from "@/lib/activations/transition";
import { resetDatabase } from "./helpers/db";

const appDir = path.resolve(__dirname, "..");
const VECTORS_PATH = path.resolve(appDir, "..", "docs", "chapter5", "audit-chain-vectors.json");
const vectors = JSON.parse(fs.readFileSync(VECTORS_PATH, "utf8")) as {
  events: Array<{ input: Record<string, string | null>; canonical: string; hash: string }>;
  merkle: { trees: Array<{ leaves: string[]; root: string }>; proofs: Array<{ size: number; index: number; leaf: string; proof: string[]; root: string }> };
};

const AWKWARD = [
  "plain",
  'quote " backslash \\ slash /',
  "line\nbreak\ttab\rreturn\bback\fform",
  "control \u0001 \u001f and DEL \u007f",
  "unicode × − é 中文 😀    ",
  "",
];

beforeEach(resetDatabase);

async function writeEvents(details: Array<string | null>): Promise<void> {
  for (const detail of details) await prisma.auditEvent.create({ data: { kind: "test", detail } });
}

async function chained() {
  return prisma.auditEvent.findMany({ include: { chain: true }, orderBy: { id: "asc" } });
}

/** As an attacker with the database owner's rights would: around the append-only trigger. */
async function tamper(eventId: bigint, detail: string): Promise<void> {
  await prisma.$executeRawUnsafe(`ALTER TABLE "AuditEvent" DISABLE TRIGGER "AuditEvent_append_only"`);
  await prisma.$executeRaw`UPDATE "AuditEvent" SET detail = ${detail} WHERE id = ${eventId}`;
  await prisma.$executeRawUnsafe(`ALTER TABLE "AuditEvent" ENABLE TRIGGER "AuditEvent_append_only"`);
}

describe("the canonical form (A1, NFR-11)", () => {
  it("reproduces every published vector exactly", () => {
    for (const vector of vectors.events) {
      const input = vector.input;
      const event = { id: input.id!, kind: input.kind!, activationId: input.activationId, fromState: input.fromState, toState: input.toState, actorId: input.actorId, detail: input.detail, at: new Date(input.at!) };
      expect(canonicalAuditEvent(event, input.sequence!, input.previousHash!)).toBe(vector.canonical);
      expect(auditEventHash(event, input.sequence!, input.previousHash!)).toBe(vector.hash);
    }
  });

  it("matches the specification's example byte for byte", () => {
    const spec = fs.readFileSync(path.resolve(appDir, "..", "docs", "chapter5", "audit-chain.md"), "utf8");
    expect(spec).toContain(vectors.events[0].canonical);
  });

  it("is reproduced by an independent Python implementation", () => {
    const candidates = [path.resolve(appDir, "..", ".venv", "Scripts", "python.exe"), path.resolve(appDir, "..", ".venv", "bin", "python"), "python3", "python"];
    const python = candidates.find((candidate) => {
      try {
        execFileSync(candidate, ["--version"], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    });
    if (!python) {
      console.warn("No Python found: the cross-language check was not run.");
      return;
    }
    const output = execFileSync(python, ["-I", path.join(appDir, "scripts", "audit_reference.py"), VECTORS_PATH], { encoding: "utf8" });
    const report = JSON.parse(output) as { ok: boolean; events: Array<{ matches: boolean }> };
    expect(report.ok).toBe(true);
    expect(report.events).toHaveLength(vectors.events.length);
  });

  it("gives the same hash in a fresh process, every time", () => {
    const script = path.join(appDir, "tests", "support", "hash-in-child.ts");
    const tsx = path.join(appDir, "node_modules", "tsx", "dist", "cli.mjs");
    const runs = [0, 1].map(() => execFileSync(process.execPath, [tsx, script, VECTORS_PATH], { encoding: "utf8" }).trim());
    expect(runs[0]).toBe(runs[1]);
    expect(JSON.parse(runs[0])).toEqual(vectors.events.map((vector) => vector.hash));
  });
});

describe("the database chains every event at commit (A2)", () => {
  it("computes the same hashes as the specification, for awkward text", async () => {
    await writeEvents([...AWKWARD, null]);
    let previous = GENESIS_HASH;
    for (const [index, event] of (await chained()).entries()) {
      const link = event.chain!;
      expect(link.sequence).toBe(BigInt(index + 1));
      expect(link.previousHash).toBe(previous);
      expect(link.hash).toBe(auditEventHash(event, link.sequence, previous));
      previous = link.hash;
    }
  });

  it("chains transitions written by the database's own trigger too", async () => {
    const { readyAssignment, submissionFor } = await import("./helpers/submission");
    const { submitActivation } = await import("@/lib/activations/submit");
    const { replyWith, startFakeScoring } = await import("./helpers/fake-scoring");
    const scoring = await startFakeScoring(replyWith("review", 0.4));
    process.env.SCORING_SERVICE_URL = scoring.url;
    try {
      const { activationId } = await submitActivation(submissionFor(await readyAssignment()));
      const transitions = await prisma.auditEvent.findMany({ where: { activationId, kind: "transition" }, include: { chain: true } });
      expect(transitions.length).toBeGreaterThan(0);
      expect(transitions.every((event) => event.chain !== null)).toBe(true);
      expect((await verifyChain(prisma)).ok).toBe(true);
    } finally {
      await scoring.close();
    }
  });

  it("writes nothing until the transaction commits, and leaves no gap when one rolls back", async () => {
    await writeEvents(["first"]);
    await expect(
      prisma.$transaction(async (tx) => {
        await recordAuditEvent(tx, { kind: "test", detail: "rolled back" });
        expect(await tx.auditChain.count()).toBe(1);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    await writeEvents(["second"]);
    const links = (await chained()).map((event) => event.chain!.sequence);
    expect(links).toEqual([1n, 2n]);
    expect((await verifyChain(prisma)).ok).toBe(true);
  });

  it("keeps a single unbroken chain under concurrent writes", async () => {
    const writers = Array.from({ length: 16 }, (_, writer) =>
      prisma.$transaction(async (tx) => {
        for (let i = 0; i < 5; i += 1) await recordAuditEvent(tx, { kind: "test", detail: `writer ${writer} event ${i}` });
      }),
    );
    await Promise.all(writers);
    const report = await verifyChain(prisma);
    expect(report).toMatchObject({ ok: true, checked: 80 });
    const sequences = (await prisma.auditChain.findMany({ orderBy: { sequence: "asc" } })).map((link) => Number(link.sequence));
    expect(sequences).toEqual(Array.from({ length: 80 }, (_, i) => i + 1));
  });
});

describe("audit events are immutable (DR-09)", () => {
  it("refuses any update or delete of an event or its link", async () => {
    await writeEvents(["original"]);
    const [event] = await chained();
    await expect(prisma.auditEvent.update({ where: { id: event.id }, data: { detail: "changed" } })).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`UPDATE "AuditEvent" SET at = now() WHERE id = ${event.id}`).rejects.toThrow(/append-only/);
    await expect(prisma.auditEvent.delete({ where: { id: event.id } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditChain.update({ where: { eventId: event.id }, data: { hash: "0".repeat(64) } })).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`DELETE FROM "AuditChain" WHERE "eventId" = ${event.id}`).rejects.toThrow(/append-only/);
    expect((await chained())[0].detail).toBe("original");
  });

  it("records a correction as a new event, which the chain covers like any other", async () => {
    await writeEvents(["Customer number entered wrongly"]);
    await recordAuditEvent(prisma, { kind: "correction", detail: "Correction to event 1: the customer number was 0712 000 000." });
    expect(await prisma.auditEvent.count()).toBe(2);
    expect((await verifyChain(prisma)).ok).toBe(true);
  });
});

describe("verifying the chain finds the first divergence (A3, A4)", () => {
  async function nineEvents() {
    await writeEvents(Array.from({ length: 9 }, (_, i) => `event ${i + 1}`));
    return chained();
  }

  for (const [label, index] of [["first", 0], ["middle", 4], ["last", 8]] as const) {
    it(`detects tampering with the ${label} event`, async () => {
      const events = await nineEvents();
      expect((await verifyChain(prisma)).ok).toBe(true);
      await tamper(events[index].id, "rewritten after the fact");
      const report = await verifyChain(prisma);
      expect(report.ok).toBe(false);
      expect(report.firstDivergence).toMatchObject({ sequence: String(index + 1), eventId: String(events[index].id), reason: "hash_mismatch" });
      expect(report.checked).toBe(index);
    });
  }

  it("detects a link changed to hide a removal or reordering", async () => {
    const events = await nineEvents();
    await prisma.$executeRawUnsafe(`ALTER TABLE "AuditChain" DISABLE TRIGGER "AuditChain_append_only"`);
    await prisma.$executeRaw`UPDATE "AuditChain" SET "previousHash" = ${"f".repeat(64)} WHERE "eventId" = ${events[5].id}`;
    await prisma.$executeRawUnsafe(`ALTER TABLE "AuditChain" ENABLE TRIGGER "AuditChain_append_only"`);
    expect((await verifyChain(prisma)).firstDivergence).toMatchObject({ sequence: "6", reason: "broken_link" });
  });

  it("cannot tell when every later hash is rewritten too: that is what anchoring is for", async () => {
    const events = await nineEvents();
    await tamper(events[2].id, "rewritten");
    // Recompute links 3..9 from the tampered data, as a thorough attacker would.
    await prisma.$executeRawUnsafe(`ALTER TABLE "AuditChain" DISABLE TRIGGER "AuditChain_append_only"`);
    let previous = events[1].chain!.hash;
    for (const event of (await chained()).slice(2)) {
      const hash = auditEventHash(event, event.chain!.sequence, previous);
      await prisma.$executeRaw`UPDATE "AuditChain" SET "previousHash" = ${previous}, hash = ${hash} WHERE "eventId" = ${event.id}`;
      previous = hash;
    }
    await prisma.$executeRawUnsafe(`ALTER TABLE "AuditChain" ENABLE TRIGGER "AuditChain_append_only"`);
    expect((await verifyChain(prisma)).ok).toBe(true);
  });
});

describe("Merkle trees as RFC 6962 defines them (B3)", () => {
  const leaf = (i: number) => auditEventHash({ id: i, kind: "k", activationId: null, fromState: null, toState: null, actorId: null, detail: String(i), at: new Date(0) }, i, GENESIS_HASH);

  it("reproduces the published roots and proofs", () => {
    for (const tree of vectors.merkle.trees) expect(merkleRoot(tree.leaves)).toBe(tree.root);
    for (const proof of vectors.merkle.proofs) {
      expect(inclusionProof(vectors.merkle.trees[4].leaves, proof.index)).toEqual(proof.proof);
      expect(verifyInclusion(proof)).toBe(true);
    }
  });

  it("splits at the largest power of two below the size", () => {
    const leaves = [leaf(1), leaf(2), leaf(3)];
    expect(merkleRoot(leaves)).toBe(nodeHash(nodeHash(leafHash(leaves[0]), leafHash(leaves[1])), leafHash(leaves[2])));
    expect(merkleRoot([leaves[0]])).toBe(leafHash(leaves[0]));
  });

  it("proves every leaf of every tree up to 33 leaves, and nothing else", () => {
    for (let size = 1; size <= 33; size += 1) {
      const leaves = Array.from({ length: size }, (_, i) => leaf(i + 1));
      const root = merkleRoot(leaves);
      for (let index = 0; index < size; index += 1) {
        const proof = inclusionProof(leaves, index);
        expect(verifyInclusion({ leaf: leaves[index], index, size, proof, root })).toBe(true);
        expect(verifyInclusion({ leaf: leaf(999), index, size, proof, root })).toBe(false);
        if (size > 1) expect(verifyInclusion({ leaf: leaves[index], index: (index + 1) % size, size, proof, root })).toBe(false);
      }
    }
  });

  it("keeps a leaf from passing for a node", () => {
    const [a, b] = [leaf(1), leaf(2)];
    const asNode = nodeHash(leafHash(a), leafHash(b));
    expect(merkleRoot([asNode])).not.toBe(merkleRoot([a, b]));
  });
});
