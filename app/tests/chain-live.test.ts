import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, http, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import artifact from "../contracts/AuditAnchor.json";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/activations/transition";
import { chainReader, chainWriter, useChain } from "@/lib/anchoring/chain";
import { runDueAnchoring } from "@/lib/anchoring/queue";
import { verifyActivationAudit } from "@/lib/audit/verify";
import { resetDatabase } from "./helpers/db";

/**
 * The real chain client (viem) against a real EVM node, normally a local
 * Anvil. Skipped unless LIVE_CHAIN_RPC_URL and LIVE_CHAIN_PRIVATE_KEY name a
 * node and a funded key on it. Nothing here is mocked.
 */
const rpc = process.env.LIVE_CHAIN_RPC_URL;
const key = process.env.LIVE_CHAIN_PRIVATE_KEY as Hex | undefined;
const live = Boolean(rpc && key);

describe.runIf(live)("the anchor contract and client on a live chain (B1, B4, C2)", () => {
  const saved = { ...process.env };
  let address: Hex;

  beforeAll(async () => {
    const account = privateKeyToAccount(key!);
    const chain = { ...foundry, rpcUrls: { default: { http: [rpc!] } } };
    const wallet = createWalletClient({ account, chain, transport: http(rpc) });
    const client = createPublicClient({ chain, transport: http(rpc) });
    const hash = await wallet.deployContract({ abi: artifact.abi as Abi, bytecode: artifact.bytecode as Hex });
    address = (await client.waitForTransactionReceipt({ hash })).contractAddress!;
    Object.assign(process.env, {
      POLYGON_RPC_URL: rpc,
      POLYGON_CHAIN_ID: String(await client.getChainId()),
      POLYGON_PRIVATE_KEY: key,
      POLYGON_ANCHOR_CONTRACT_ADDRESS: address,
      ANCHOR_RECEIPT_TIMEOUT_MS: "30000",
    });
    useChain();
  }, 120_000);

  afterAll(() => {
    process.env = { ...saved };
  });

  it("records a root once, with its time, and refuses it a second time", async () => {
    const writer = chainWriter()!;
    const root = "ab".repeat(32);
    expect(await writer.anchoredAt(root)).toBe(0n);
    const txHash = await writer.submit(root);
    expect(await writer.waitForReceipt(txHash, 30_000)).toMatchObject({ status: "success" });
    expect(await writer.anchoredAt(root)).toBeGreaterThan(0n);
    expect(await writer.receiptLog(txHash)).toMatchObject({ root, txHash, submitter: writer.submitter });
    expect(await writer.findAnchorLog(root, 0n)).toMatchObject({ txHash });
    await expect(writer.submit(root)).rejects.toThrow(/AlreadyAnchored|revert/i);
  }, 120_000);

  it("anchors the audit chain through the real client, and verification reads it back from the chain", async () => {
    await resetDatabase();
    const activationId = "live-activation";
    for (let i = 0; i < 5; i += 1) await recordAuditEvent(prisma, { kind: "test", activationId, detail: `live event ${i}` });
    const summary = await runDueAnchoring(new Date());
    expect(summary).toMatchObject({ created: 1, confirmed: 1 });
    const anchor = await prisma.auditAnchor.findFirstOrThrow();
    expect(await chainReader()!.anchoredAt(anchor.root)).toBeGreaterThan(0n);
    expect((await verifyActivationAudit(prisma, activationId)).status).toBe("verified");

    const target = await prisma.auditEvent.findFirstOrThrow({ where: { activationId, detail: "live event 2" } });
    await prisma.$executeRawUnsafe(`ALTER TABLE "AuditEvent" DISABLE TRIGGER "AuditEvent_append_only"`);
    await prisma.$executeRaw`UPDATE "AuditEvent" SET detail = 'tampered' WHERE id = ${target.id}`;
    await prisma.$executeRawUnsafe(`ALTER TABLE "AuditEvent" ENABLE TRIGGER "AuditEvent_append_only"`);
    const tampered = await verifyActivationAudit(prisma, activationId);
    expect(tampered.status).toBe("failed");
    expect(tampered.events.find((check) => check.eventId === String(target.id))).toMatchObject({ hashMatches: false });
  }, 180_000);
});
