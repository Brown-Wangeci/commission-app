import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { useChain } from "@/lib/anchoring/chain";
import { runDueAnchoring } from "@/lib/anchoring/queue";
import { auditEventHash } from "@/lib/audit/canonical";
import { verifyChain } from "@/lib/audit/chain";
import { auditRecord } from "@/lib/audit/history";
import { verifyActivationAudit } from "@/lib/audit/verify";
import { refuseActivation } from "@/lib/review/actions";
import { contestRefusal } from "@/lib/disputes/disputes";
import { resetDatabase } from "./helpers/db";
import { FakeChain } from "./helpers/fake-chain";
import { createAgent, createClient, createUser } from "./helpers/factories";
import { replyWith, startFakeScoring, type FakeScoring } from "./helpers/fake-scoring";
import { submitReady } from "./helpers/submission";

const sessionUser = vi.hoisted(() => ({ current: { id: "", name: "", email: "", role: "admin" as "admin" | "agent" | "client" } }));
vi.mock("@/lib/auth/session", () => ({
  requireApiRole: vi.fn(async (role: string) => {
    if (sessionUser.current.role !== role) throw Object.assign(new Error("forbidden"), { status: 403 });
    return sessionUser.current;
  }),
}));
const { requireAuditAccess } = await import("@/lib/audit/access");

const t0 = new Date("2026-11-08T08:00:00.000Z");

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

/** A disputed submission: refused by a reviewer, then contested by its agent. */
async function disputed(): Promise<string> {
  const reviewer = await createUser("admin");
  const { activationId } = await submitReady();
  await refuseActivation({ activationId, reviewerId: reviewer.id, reason: "Photos were taken elsewhere" });
  const activation = await prisma.activation.findUniqueOrThrow({ where: { id: activationId } });
  await contestRefusal({ activationId, agentId: activation.agentId, note: "I was at the stall; the customer will confirm." });
  return activationId;
}

async function disableTriggers(): Promise<void> {
  await prisma.$executeRawUnsafe(`ALTER TABLE "AuditEvent" DISABLE TRIGGER "AuditEvent_append_only"`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "AuditChain" DISABLE TRIGGER "AuditChain_append_only"`);
}

async function enableTriggers(): Promise<void> {
  await prisma.$executeRawUnsafe(`ALTER TABLE "AuditEvent" ENABLE TRIGGER "AuditEvent_append_only"`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "AuditChain" ENABLE TRIGGER "AuditChain_append_only"`);
}

describe("retrieving a submission's audit record (FR-22, C1)", () => {
  it("lists every event in chain order, each with its hash and anchor status", async () => {
    const id = await disputed();
    const before = await auditRecord(prisma, id);
    expect(before.length).toBeGreaterThan(3);
    expect(before.map((e) => Number(e.sequence))).toEqual([...before.map((e) => Number(e.sequence))].sort((a, b) => a - b));
    expect(before.every((e) => /^[0-9a-f]{64}$/.test(e.hash ?? "") && e.anchor.state === "awaiting_batch")).toBe(true);
    expect(before.some((e) => e.toState === "disputed")).toBe(true);

    await runDueAnchoring(t0);
    const anchored = await auditRecord(prisma, id);
    const anchor = await prisma.auditAnchor.findFirstOrThrow();
    for (const event of anchored) {
      expect(event.anchor).toMatchObject({
        state: "anchored",
        root: anchor.root,
        txHash: anchor.txHash,
        blockNumber: String(anchor.blockNumber),
        txUrl: `https://amoy.polygonscan.com/tx/${anchor.txHash}`,
      });
    }
  });

  it("shows a batch still being anchored, with its last error", async () => {
    const id = await disputed();
    chain.mode = "down";
    await runDueAnchoring(t0);
    const [first] = await auditRecord(prisma, id);
    expect(first.anchor).toMatchObject({ state: "queued", escalated: false });
    expect(first.anchor.state === "queued" && first.anchor.lastError).toMatch(/ECONNREFUSED/);
  });
});

describe("independent verification against the chain (FR-22, C2)", () => {
  it("verifies a disputed submission: hashes recompute, proofs hold, and the contract holds the root", async () => {
    const id = await disputed();
    await runDueAnchoring(t0);
    chain.calls.length = 0;
    const result = await verifyActivationAudit(prisma, id);
    expect(result.status).toBe("verified");
    expect(result.events.length).toBeGreaterThan(3);
    for (const check of result.events) {
      expect(check).toMatchObject({ hashMatches: true, linkMatches: true, proofValid: true, ok: true });
      expect(check.batch?.onChain).toMatchObject({ checked: true, rootOnChain: true, matchesTransaction: true });
    }
    // It asked the chain, not only the database.
    expect(chain.calls).toContain("anchoredAt");
    expect(chain.calls).toContain("receiptLog");
  });

  it("fails on a tampered event, naming it", async () => {
    const id = await disputed();
    await runDueAnchoring(t0);
    const target = await prisma.auditEvent.findFirstOrThrow({ where: { activationId: id, toState: "disputed" } });
    await disableTriggers();
    await prisma.$executeRaw`UPDATE "AuditEvent" SET detail = 'The reviewer approved this.' WHERE id = ${target.id}`;
    await enableTriggers();
    const result = await verifyActivationAudit(prisma, id);
    expect(result.status).toBe("failed");
    const failed = result.events.find((check) => check.eventId === String(target.id))!;
    expect(failed).toMatchObject({ hashMatches: false, ok: false });
    expect(failed.batch).toMatchObject({ rootMatches: false, onChain: { checked: true, rootOnChain: false } });
    expect(result.summary).toMatch(new RegExp(`event ${target.id}`));
  });

  it("still fails when every later hash is rewritten to hide it, because the root on chain cannot change", async () => {
    const id = await disputed();
    await runDueAnchoring(t0);
    const target = await prisma.auditEvent.findFirstOrThrow({ where: { activationId: id, toState: "disputed" }, include: { chain: true } });
    await disableTriggers();
    await prisma.$executeRaw`UPDATE "AuditEvent" SET detail = 'The reviewer approved this.' WHERE id = ${target.id}`;
    let previous = target.chain!.previousHash;
    const links = await prisma.auditChain.findMany({ where: { sequence: { gte: target.chain!.sequence } }, orderBy: { sequence: "asc" }, include: { event: true } });
    for (const link of links) {
      const hash = auditEventHash(link.event, link.sequence, previous);
      await prisma.$executeRaw`UPDATE "AuditChain" SET "previousHash" = ${previous}, hash = ${hash} WHERE "eventId" = ${link.eventId}`;
      previous = hash;
    }
    await enableTriggers();
    expect((await verifyChain(prisma)).ok).toBe(true);
    const result = await verifyActivationAudit(prisma, id);
    expect(result.status).toBe("failed");
    expect(result.events.every((check) => check.hashMatches)).toBe(true);
    expect(result.events.some((check) => check.batch?.onChain.checked && !check.batch.onChain.rootOnChain)).toBe(true);
  });

  it("trusts the chain over the database: a root the contract never recorded fails", async () => {
    const id = await disputed();
    await runDueAnchoring(t0);
    chain.roots.clear();
    const result = await verifyActivationAudit(prisma, id);
    expect(result.status).toBe("failed");
    expect(result.events[0].batch?.onChain).toMatchObject({ checked: true, rootOnChain: false });
  });

  it("is only partly verified before anchoring, or when the chain cannot be read, and says why", async () => {
    const id = await disputed();
    const before = await verifyActivationAudit(prisma, id);
    expect(before.status).toBe("partly_verified");
    expect(before.events.every((check) => check.hashMatches && check.linkMatches)).toBe(true);
    await runDueAnchoring(t0);
    chain.mode = "down";
    const unreachable = await verifyActivationAudit(prisma, id);
    expect(unreachable.status).toBe("partly_verified");
    expect(unreachable.events[0].batch?.onChain).toMatchObject({ checked: false, reason: expect.stringMatching(/could not be read/) });
  });
});

describe("who may read and verify a record (FR-22)", () => {
  it("lets an administrator, the submitting agent and the job's client in, and nobody else", async () => {
    const id = await disputed();
    const activation = await prisma.activation.findUniqueOrThrow({ where: { id }, include: { agent: true, job: { include: { client: true } } } });
    const admin = await createUser("admin");
    sessionUser.current = { id: admin.id, name: "", email: "", role: "admin" };
    await expect(requireAuditAccess("admin", id)).resolves.toBeUndefined();
    sessionUser.current = { id: activation.agent.userId, name: "", email: "", role: "agent" };
    await expect(requireAuditAccess("agent", id)).resolves.toBeUndefined();
    sessionUser.current = { id: activation.job.client.userId, name: "", email: "", role: "client" };
    await expect(requireAuditAccess("client", id)).resolves.toBeUndefined();

    const otherAgent = await createAgent();
    sessionUser.current = { id: otherAgent.userId, name: "", email: "", role: "agent" };
    await expect(requireAuditAccess("agent", id)).rejects.toMatchObject({ status: 404 });
    const otherClient = await createClient();
    sessionUser.current = { id: otherClient.userId, name: "", email: "", role: "client" };
    await expect(requireAuditAccess("client", id)).rejects.toMatchObject({ status: 404 });
    await expect(requireAuditAccess("client", "no-such-submission")).rejects.toMatchObject({ status: 404 });
  });
});
