import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/activations/transition";
import { useChain } from "@/lib/anchoring/chain";
import { missingChainSettings, scrubChainText } from "@/lib/anchoring/credentials";
import { retryAnchor, runDueAnchoring } from "@/lib/anchoring/queue";
import { auditEventHash } from "@/lib/audit/canonical";
import { merkleRoot } from "@/lib/audit/merkle";
import { approveActivation } from "@/lib/review/actions";
import { resetDatabase } from "./helpers/db";
import { FakeChain } from "./helpers/fake-chain";
import { createUser } from "./helpers/factories";
import { replyWith, startFakeScoring, type FakeScoring } from "./helpers/fake-scoring";
import { submitReady } from "./helpers/submission";

const HOUR = 60 * 60 * 1000;
const t0 = new Date("2026-11-08T08:00:00.000Z");
const after = (ms: number) => new Date(t0.getTime() + ms);

let chain: FakeChain;
let scoring: FakeScoring;

beforeAll(async () => {
  scoring = await startFakeScoring(replyWith("reject", 0.9));
  process.env.SCORING_SERVICE_URL = scoring.url;
});
afterAll(() => scoring.close());
beforeEach(async () => {
  await resetDatabase();
  chain = new FakeChain();
  useChain(chain);
});
afterEach(() => useChain());

async function events(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await recordAuditEvent(prisma, { kind: "test", detail: `event ${i}` });
}

async function storedHashes(from: bigint, to: bigint): Promise<string[]> {
  const links = await prisma.auditChain.findMany({ where: { sequence: { gte: from, lte: to } }, orderBy: { sequence: "asc" } });
  return links.map((link) => link.hash);
}

describe("anchoring a batch (B3, FR-21, IR-04)", () => {
  it("anchors the RFC 6962 root of every event so far, and stores the transaction and block against them", async () => {
    await events(7);
    const summary = await runDueAnchoring(t0);
    expect(summary).toMatchObject({ created: 1, confirmed: 1, failed: 0 });
    const anchor = await prisma.auditAnchor.findFirstOrThrow();
    expect(anchor).toMatchObject({ fromSequence: 1n, toSequence: 7n, leafCount: 7, status: "confirmed", chainId: 80002, contractAddress: chain.contractAddress });
    expect(anchor.root).toBe(merkleRoot(await storedHashes(1n, 7n)));
    const onChain = chain.roots.get(anchor.root)!;
    expect(anchor).toMatchObject({ txHash: onChain.txHash, blockNumber: onChain.blockNumber, submitter: chain.submitter });
    expect(anchor.chainTimestamp?.getTime()).toBe(Number(onChain.timestamp) * 1000);
  });

  it("records the anchoring itself as an audit event, which the next batch covers", async () => {
    await events(3);
    await runDueAnchoring(t0);
    const record = await prisma.auditEvent.findFirstOrThrow({ where: { kind: "audit_anchored" }, include: { chain: true } });
    expect(record.detail).toMatch(/Audit events 1 to 3 anchored on chain 80002/);
    await runDueAnchoring(after(HOUR));
    const second = await prisma.auditAnchor.findFirstOrThrow({ where: { fromSequence: 4n } });
    expect(second.toSequence).toBeGreaterThanOrEqual(record.chain!.sequence);
  });

  it("anchors periodically, not per event: nothing new until the interval has passed", async () => {
    await events(2);
    await runDueAnchoring(t0);
    await events(5);
    expect(await runDueAnchoring(after(HOUR - 1000))).toMatchObject({ created: 0 });
    expect(await prisma.auditAnchor.count()).toBe(1);
    expect(await runDueAnchoring(after(HOUR))).toMatchObject({ created: 1, confirmed: 1 });
    const second = await prisma.auditAnchor.findFirstOrThrow({ where: { fromSequence: 3n } });
    expect(second.toSequence).toBe(8n);
  });

  it("caps a batch at ANCHOR_MAX_LEAVES and carries on from where it stopped", async () => {
    process.env.ANCHOR_MAX_LEAVES = "4";
    try {
      await events(10);
      await runDueAnchoring(t0);
      const anchors = await prisma.auditAnchor.findMany({ orderBy: { fromSequence: "asc" } });
      expect(anchors.map((a) => [a.fromSequence, a.toSequence])).toEqual([[1n, 4n], [5n, 8n]]);
    } finally {
      delete process.env.ANCHOR_MAX_LEAVES;
    }
  });

  it("does nothing, and spends no attempts, while the chain is not configured", async () => {
    useChain(null);
    await events(3);
    expect(await runDueAnchoring(t0)).toMatchObject({ skipped: true });
    expect(await prisma.auditAnchor.count()).toBe(0);
  });
});

describe("when the chain is unavailable (B4, IR-05)", () => {
  it("never blocks a submission or an approval: they work with the chain down and make no chain call", async () => {
    chain.mode = "down";
    const reviewer = await createUser("admin");
    const { activationId } = await submitReady();
    await approveActivation({ activationId, reviewerId: reviewer.id, reason: "Evidence checks out" });
    expect((await prisma.activation.findUniqueOrThrow({ where: { id: activationId } })).state).toBe("approved");
    expect(chain.calls).toEqual([]);
    expect(await prisma.auditChain.count()).toBeGreaterThan(0);
  });

  it("keeps events waiting, and anchors everything that accumulated on the next successful run", async () => {
    await events(3);
    chain.mode = "down";
    expect(await runDueAnchoring(t0)).toMatchObject({ created: 1, confirmed: 0, failed: 1 });
    const pending = await prisma.auditAnchor.findFirstOrThrow();
    expect(pending).toMatchObject({ status: "pending", attempts: 1, fromSequence: 1n, toSequence: 3n });
    expect(pending.lastError).toMatch(/ECONNREFUSED/);
    expect(pending.nextAttemptAt.getTime()).toBe(t0.getTime() + 60_000);
    await events(4);
    chain.mode = "up";
    const summary = await runDueAnchoring(after(2 * HOUR));
    expect(summary).toMatchObject({ confirmed: 2 });
    const anchors = await prisma.auditAnchor.findMany({ orderBy: { fromSequence: "asc" } });
    expect(anchors.every((a) => a.status === "confirmed")).toBe(true);
    expect(anchors[1].fromSequence).toBe(4n);
    expect(anchors[1].toSequence).toBeGreaterThanOrEqual(7n);
  });

  it("retries with doubling delays, then stops and tells every administrator", async () => {
    const admin = await createUser("admin");
    await events(2);
    chain.mode = "down";
    let now = t0;
    for (let i = 0; i < 6; i += 1) {
      await runDueAnchoring(now);
      now = (await prisma.auditAnchor.findFirstOrThrow()).nextAttemptAt;
    }
    const anchor = await prisma.auditAnchor.findFirstOrThrow();
    expect(anchor.attempts).toBe(6);
    expect(anchor.escalatedAt).not.toBeNull();
    expect(await prisma.notification.count({ where: { userId: admin.id, kind: "payment_attention" } })).toBe(1);
    const calls = chain.calls.length;
    expect(await runDueAnchoring(after(100 * HOUR))).toMatchObject({ waiting: expect.stringMatching(/needs an administrator/) });
    expect(chain.calls.length).toBe(calls);
  });

  it("resumes when an administrator retries the stalled batch", async () => {
    const admin = await createUser("admin");
    await events(2);
    chain.mode = "down";
    process.env.ANCHOR_MAX_ATTEMPTS = "1";
    try {
      await runDueAnchoring(t0);
    } finally {
      delete process.env.ANCHOR_MAX_ATTEMPTS;
    }
    const stalled = await prisma.auditAnchor.findFirstOrThrow();
    expect(stalled.escalatedAt).not.toBeNull();
    chain.mode = "up";
    expect(await retryAnchor(stalled.id, admin.id, after(1000))).toBe(true);
    expect(await retryAnchor(stalled.id, admin.id, after(1000))).toBe(false);
    await runDueAnchoring(after(2000));
    expect((await prisma.auditAnchor.findUniqueOrThrow({ where: { id: stalled.id } })).status).toBe("confirmed");
    expect(await prisma.auditEvent.count({ where: { kind: "anchor_retried", actorId: admin.id } })).toBe(1);
  });
});

describe("sending more than once is harmless", () => {
  it("finds a root already on chain (a crash after sending) and records it, without sending again", async () => {
    await events(3);
    chain.mode = "down";
    await runDueAnchoring(t0);
    const pending = await prisma.auditAnchor.findFirstOrThrow();
    chain.mode = "up";
    const earlier = chain.mine(pending.root)!;
    chain.calls.length = 0;
    await runDueAnchoring(pending.nextAttemptAt);
    expect(chain.calls).not.toContain("submit");
    expect(await prisma.auditAnchor.findFirstOrThrow()).toMatchObject({ status: "confirmed", txHash: earlier.txHash, blockNumber: earlier.blockNumber });
  });

  it("treats a revert by a concurrent anchoring as success, from the transaction that got there first", async () => {
    await events(2);
    chain.mode = "revert";
    const original = chain.submit.bind(chain);
    let winner: string | null = null;
    chain.submit = async (root: string) => {
      winner = chain.mine(root)!.txHash;
      return original(root);
    };
    await runDueAnchoring(t0);
    expect(await prisma.auditAnchor.findFirstOrThrow()).toMatchObject({ status: "confirmed", txHash: winner });
  });

  it("waits for a slow receipt without counting a failure, and confirms on the next run", async () => {
    await events(2);
    chain.mode = "receipt_timeout";
    expect(await runDueAnchoring(t0)).toMatchObject({ confirmed: 0, failed: 0, waiting: "Receipt not yet seen." });
    const sent = await prisma.auditAnchor.findFirstOrThrow();
    expect(sent).toMatchObject({ status: "submitted" });
    chain.mode = "up";
    chain.calls.length = 0;
    await runDueAnchoring(sent.nextAttemptAt);
    expect(chain.calls).not.toContain("submit");
    expect(await prisma.auditAnchor.findFirstOrThrow()).toMatchObject({ status: "confirmed", txHash: sent.txHash });
  });

  it("raises a revert it cannot explain as a failure, to be retried", async () => {
    await events(2);
    chain.mode = "revert";
    expect(await runDueAnchoring(t0)).toMatchObject({ failed: 1 });
    expect((await prisma.auditAnchor.findFirstOrThrow()).lastError).toMatch(/reverted/);
  });
});

describe("the queue refuses to anchor a tampered log", () => {
  it("checks the chain before cutting a batch, and raises instead of anchoring", async () => {
    const admin = await createUser("admin");
    await events(4);
    const target = await prisma.auditEvent.findFirstOrThrow({ where: { detail: "event 1" } });
    await prisma.$executeRawUnsafe(`ALTER TABLE "AuditEvent" DISABLE TRIGGER "AuditEvent_append_only"`);
    await prisma.$executeRaw`UPDATE "AuditEvent" SET detail = 'rewritten' WHERE id = ${target.id}`;
    await prisma.$executeRawUnsafe(`ALTER TABLE "AuditEvent" ENABLE TRIGGER "AuditEvent_append_only"`);
    expect(await runDueAnchoring(t0)).toMatchObject({ failed: 1, created: 0 });
    expect(await prisma.auditAnchor.count()).toBe(0);
    expect(chain.calls).not.toContain("submit");
    const note = await prisma.notification.findFirstOrThrow({ where: { userId: admin.id } });
    expect(note.message).toMatch(/broken at sequence 2 \(hash_mismatch\)/);
  });
});

describe("the database keeps batches honest", () => {
  it("refuses a batch that skips, overlaps, overruns the chain or miscounts", async () => {
    await events(5);
    const base = { root: "a".repeat(64), chainId: 80002, contractAddress: chain.contractAddress, nextAttemptAt: t0 };
    await expect(prisma.auditAnchor.create({ data: { ...base, fromSequence: 2n, toSequence: 3n, leafCount: 2 } })).rejects.toThrow(/continue the chain from sequence 1/);
    await expect(prisma.auditAnchor.create({ data: { ...base, fromSequence: 1n, toSequence: 9n, leafCount: 9 } })).rejects.toThrow(/continue the chain/);
    await expect(prisma.auditAnchor.create({ data: { ...base, fromSequence: 1n, toSequence: 3n, leafCount: 2 } })).rejects.toThrow(/continue the chain/);
    await prisma.auditAnchor.create({ data: { ...base, fromSequence: 1n, toSequence: 3n, leafCount: 3 } });
    await expect(prisma.auditAnchor.create({ data: { ...base, root: "b".repeat(64), fromSequence: 3n, toSequence: 5n, leafCount: 3 } })).rejects.toThrow(/continue the chain from sequence 4/);
  });

  it("will not change a batch's range or root, change a confirmed anchor, or delete one", async () => {
    await events(3);
    await runDueAnchoring(t0);
    const anchor = await prisma.auditAnchor.findFirstOrThrow();
    await expect(prisma.auditAnchor.update({ where: { id: anchor.id }, data: { root: "c".repeat(64) } })).rejects.toThrow(/range and root cannot change/);
    await expect(prisma.auditAnchor.update({ where: { id: anchor.id }, data: { txHash: "0xdead" } })).rejects.toThrow(/confirmed anchor cannot change/);
    await expect(prisma.auditAnchor.update({ where: { id: anchor.id }, data: { status: "pending" } })).rejects.toThrow(/confirmed anchor cannot change/);
    await expect(prisma.auditAnchor.delete({ where: { id: anchor.id } })).rejects.toThrow(/append-only/);
  });
});

describe("credentials (B5)", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it("names a missing private key, and never shows its value", () => {
    expect(missingChainSettings()).toEqual(["POLYGON_PRIVATE_KEY"]);
    process.env.POLYGON_PRIVATE_KEY = `0x${"1".repeat(64)}`;
    expect(missingChainSettings()).toEqual([]);
  });

  it("scrubs the key and the RPC URL from any message", () => {
    process.env.POLYGON_PRIVATE_KEY = `0x${"2".repeat(64)}`;
    process.env.POLYGON_RPC_URL = "https://polygon-amoy.example/v2/secret-api-key";
    const text = scrubChainText(`signing with 0x${"2".repeat(64)} failed. URL: https://polygon-amoy.example/v2/secret-api-key`);
    expect(text).not.toContain("2222222222");
    expect(text).not.toContain("secret-api-key");
    expect(text).toContain("[redacted]");
  });

  it("keeps the key out of every log line and stored error when sending fails", async () => {
    process.env.POLYGON_PRIVATE_KEY = `0x${"3".repeat(64)}`;
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await events(1);
    chain.mode = "down";
    chain.submit = async () => {
      throw new Error(`could not sign with 0x${"3".repeat(64)}`);
    };
    chain.mode = "up";
    await runDueAnchoring(t0);
    const stored = JSON.stringify(await prisma.auditAnchor.findMany(), (_k, v) => (typeof v === "bigint" ? String(v) : v));
    expect(stored).not.toContain("3333333333");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("3333333333");
    logged.mockRestore();
  });
});

describe("hashes the queue anchors are the specification's", () => {
  it("anchors exactly the hashes recomputed from stored fields", async () => {
    await events(3);
    await runDueAnchoring(t0);
    const anchor = await prisma.auditAnchor.findFirstOrThrow();
    const linked = await prisma.auditEvent.findMany({ include: { chain: true }, orderBy: { id: "asc" } });
    const recomputed = linked.filter((e) => e.chain!.sequence <= 3n).map((e) => auditEventHash(e, e.chain!.sequence, e.chain!.previousHash));
    expect(anchor.root).toBe(merkleRoot(recomputed));
  });
});
