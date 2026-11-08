import { randomBytes } from "node:crypto";
import type { AnchorLog, ChainWriter, Receipt } from "@/lib/anchoring/chain";

/**
 * An in-memory stand-in for the AuditAnchor contract on a chain, behaving as
 * the contract does: a root is recorded once, a second anchor() reverts. A
 * test can take it down, make sends revert, or make receipts slow.
 */
export type ChainMode = "up" | "down" | "receipt_timeout" | "revert";

export class FakeChain implements ChainWriter {
  readonly chainId = 80002;
  readonly contractAddress = "0x00000000000000000000000000000000000000a1";
  readonly submitter = "0x000000000000000000000000000000000000beef";
  mode: ChainMode = "up";
  block = 1000n;
  readonly roots = new Map<string, AnchorLog>();
  readonly receipts = new Map<string, Receipt & { log: AnchorLog | null }>();
  readonly calls: string[] = [];

  private check(call: string): void {
    this.calls.push(call);
    if (this.mode === "down") throw new Error("fetch failed: connect ECONNREFUSED 127.0.0.1:8545");
  }

  async blockNumber(): Promise<bigint> {
    this.check("blockNumber");
    return this.block;
  }

  async anchoredAt(root: string): Promise<bigint> {
    this.check("anchoredAt");
    return this.roots.get(root)?.timestamp ?? 0n;
  }

  async receiptLog(txHash: string): Promise<AnchorLog | null> {
    this.check("receiptLog");
    return this.receipts.get(txHash)?.log ?? null;
  }

  async findAnchorLog(root: string): Promise<AnchorLog | null> {
    this.check("findAnchorLog");
    return this.roots.get(root) ?? null;
  }

  /** Records the root as the contract would, in a new block. */
  mine(root: string, txHash: string = `0x${randomBytes(32).toString("hex")}`): AnchorLog | null {
    this.block += 1n;
    if (this.roots.has(root)) {
      this.receipts.set(txHash, { status: "reverted", blockNumber: this.block, log: null });
      return null;
    }
    const log: AnchorLog = { root, txHash, blockNumber: this.block, timestamp: 1_800_000_000n + this.block, submitter: this.submitter };
    this.roots.set(root, log);
    this.receipts.set(txHash, { status: "success", blockNumber: this.block, log });
    return log;
  }

  async submit(root: string): Promise<string> {
    this.check("submit");
    const txHash = `0x${randomBytes(32).toString("hex")}`;
    if (this.mode === "revert") {
      this.block += 1n;
      this.receipts.set(txHash, { status: "reverted", blockNumber: this.block, log: null });
    } else {
      this.mine(root, txHash);
    }
    return txHash;
  }

  async waitForReceipt(txHash: string): Promise<Receipt | null> {
    this.check("waitForReceipt");
    if (this.mode === "receipt_timeout") return null;
    const receipt = this.receipts.get(txHash);
    return receipt ? { status: receipt.status, blockNumber: receipt.blockNumber } : null;
  }
}
