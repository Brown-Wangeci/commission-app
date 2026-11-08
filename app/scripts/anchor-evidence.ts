/**
 * Captures the blockchain evidence for Build 4 (section D) into a folder:
 * anchors every event in the database, reads each anchor back from the chain,
 * verifies a disputed submission (it should pass), then tampers with one of
 * its events and verifies again (it should fail), twice: once naively, once
 * rewriting every later hash so the local chain looks consistent.
 *
 * It CHANGES AUDIT DATA to show tampering. It refuses any database whose name
 * does not start with "ledgerfield_evidence", so it can only run on a scratch
 * copy made for the purpose.
 *
 * Usage: DATABASE_URL=.../ledgerfield_evidence_<x> npm run anchor:evidence -- <dir>
 * with POLYGON_RPC_URL, POLYGON_CHAIN_ID, POLYGON_PRIVATE_KEY and
 * POLYGON_ANCHOR_CONTRACT_ADDRESS set (from npm run contract:deploy).
 */
import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "./load-env";

loadEnv();
process.env.ANCHOR_INTERVAL_SECONDS = "1";

const json = (value: unknown) => `${JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? String(v) : v), 2)}\n`;

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) throw new Error("Give the evidence folder as the first argument.");
  const database = new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
  if (!database.startsWith("ledgerfield_evidence")) throw new Error(`Refusing to tamper with database "${database}": its name must start with ledgerfield_evidence.`);
  fs.mkdirSync(dir, { recursive: true });

  const { prisma } = await import("../src/lib/db");
  const { runDueAnchoring } = await import("../src/lib/anchoring/queue");
  const { chainReader } = await import("../src/lib/anchoring/chain");
  const { explorerBase } = await import("../src/lib/anchoring/credentials");
  const { verifyChain } = await import("../src/lib/audit/chain");
  const { verifyActivationAudit } = await import("../src/lib/audit/verify");
  const { auditEventHash } = await import("../src/lib/audit/canonical");
  const { config } = await import("../src/lib/config");

  // Anchor everything, batch after batch, until nothing waits.
  let now = Date.now();
  for (let round = 0; round < 20; round += 1) {
    now += 5_000;
    const summary = await runDueAnchoring(new Date(now));
    console.log(`anchoring round ${round + 1}: ${JSON.stringify(summary)}`);
    const head = (await prisma.auditChain.findFirst({ orderBy: { sequence: "desc" } }))!.sequence;
    const last = await prisma.auditAnchor.findFirst({ where: { status: "confirmed" }, orderBy: { toSequence: "desc" } });
    if (summary.failed > 0) throw new Error("Anchoring failed; see the batch's lastError.");
    if (last && last.toSequence >= head - 1n) break;
  }

  const reader = chainReader()!;
  const base = explorerBase(reader.chainId, config().POLYGON_EXPLORER_URL);
  const anchors = await prisma.auditAnchor.findMany({ where: { status: "confirmed" }, orderBy: { fromSequence: "asc" } });
  const readBack = [];
  for (const anchor of anchors) {
    readBack.push({
      events: `${anchor.fromSequence} to ${anchor.toSequence}`,
      leafCount: anchor.leafCount,
      root: anchor.root,
      transactionHash: anchor.txHash,
      blockNumber: anchor.blockNumber,
      transactionUrl: base ? `${base}/tx/${anchor.txHash}` : null,
      readFromChain: { anchoredAt: await reader.anchoredAt(anchor.root), transactionLog: await reader.receiptLog(anchor.txHash!) },
    });
  }
  fs.writeFileSync(path.join(dir, "02-anchoring.json"), json({ chainId: reader.chainId, contractAddress: reader.contractAddress, anchors: readBack }));

  const disputed = await prisma.activation.findFirst({ where: { state: "disputed" }, orderBy: { submittedAt: "asc" } });
  const subject = disputed ?? (await prisma.activation.findFirstOrThrow({ orderBy: { submittedAt: "asc" } }));
  const pass = await verifyActivationAudit(prisma, subject.id);
  const wholeChain = await verifyChain(prisma);
  fs.writeFileSync(path.join(dir, "03-verification-pass.json"), json({ activation: subject.reference, state: subject.state, wholeChain, verification: pass }));
  console.log(`verification of ${subject.reference}: ${pass.status}`);

  // Tamper with the submission's most telling event: its move into dispute, or its last event.
  const events = await prisma.auditEvent.findMany({ where: { activationId: subject.id }, include: { chain: true }, orderBy: { id: "asc" } });
  const target = events.find((e) => e.toState === "disputed") ?? events[events.length - 1];
  const original = target.detail;
  await prisma.$executeRawUnsafe(`ALTER TABLE "AuditEvent" DISABLE TRIGGER "AuditEvent_append_only"`);
  await prisma.$executeRaw`UPDATE "AuditEvent" SET detail = ${"Changed after the fact: the reviewer approved this."} WHERE id = ${target.id}`;
  await prisma.$executeRawUnsafe(`ALTER TABLE "AuditEvent" ENABLE TRIGGER "AuditEvent_append_only"`);
  const tampered = await verifyActivationAudit(prisma, subject.id);
  fs.writeFileSync(
    path.join(dir, "04-verification-tampered.json"),
    json({ activation: subject.reference, tamperedEvent: { id: target.id, sequence: target.chain?.sequence, originalDetail: original, newDetail: "Changed after the fact: the reviewer approved this." }, wholeChain: await verifyChain(prisma), verification: tampered }),
  );
  console.log(`after tampering: ${tampered.status}`);

  // A thorough attacker also rewrites every later stored hash, so the local chain verifies again.
  await prisma.$executeRawUnsafe(`ALTER TABLE "AuditChain" DISABLE TRIGGER "AuditChain_append_only"`);
  let previous = target.chain!.previousHash;
  const later = await prisma.auditChain.findMany({ where: { sequence: { gte: target.chain!.sequence } }, orderBy: { sequence: "asc" }, include: { event: true } });
  for (const link of later) {
    const hash = auditEventHash(link.event, link.sequence, previous);
    await prisma.$executeRaw`UPDATE "AuditChain" SET "previousHash" = ${previous}, hash = ${hash} WHERE "eventId" = ${link.eventId}`;
    previous = hash;
  }
  await prisma.$executeRawUnsafe(`ALTER TABLE "AuditChain" ENABLE TRIGGER "AuditChain_append_only"`);
  const rewritten = await verifyActivationAudit(prisma, subject.id);
  fs.writeFileSync(path.join(dir, "05-verification-rewritten-chain.json"), json({ activation: subject.reference, rewrittenFromSequence: target.chain!.sequence, linksRewritten: later.length, wholeChain: await verifyChain(prisma), verification: rewritten }));
  console.log(`after rewriting the chain: local chain ${(await verifyChain(prisma)).ok ? "consistent" : "broken"}, verification ${rewritten.status}`);

  fs.writeFileSync(
    path.join(dir, "run-summary.json"),
    json({
      chainId: reader.chainId,
      contractAddress: reader.contractAddress,
      batches: anchors.length,
      eventsAnchored: anchors.reduce((total, a) => total + a.leafCount, 0),
      subject: subject.reference,
      results: { untouched: pass.status, tampered: tampered.status, tamperedAndChainRewritten: rewritten.status },
    }),
  );
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
