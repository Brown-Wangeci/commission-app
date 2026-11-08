import { createPublicClient, createWalletClient, defineChain, getAbiItem, http, parseEventLogs, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import artifact from "../../../contracts/AuditAnchor.json";
import { config } from "@/lib/config";
import { chainReadSettings, writerKeyPresent, type ChainReadSettings } from "./credentials";

/**
 * The boundary to the blockchain. Everything the app asks of the chain goes
 * through this interface, so the queue and the verifier can be tested against
 * a fake, and a local node or Polygon Amoy can stand behind it unchanged.
 */
export type AnchorLog = { root: string; txHash: string; blockNumber: bigint; timestamp: bigint; submitter: string };
export type Receipt = { status: "success" | "reverted"; blockNumber: bigint };

export interface ChainReader {
  readonly chainId: number;
  readonly contractAddress: string;
  blockNumber(): Promise<bigint>;
  /** The contract's own record: Unix seconds the root was anchored, 0 if never. */
  anchoredAt(root: string): Promise<bigint>;
  /** The Anchored event inside this transaction, read from its receipt. */
  receiptLog(txHash: string): Promise<AnchorLog | null>;
  /** The Anchored event for this root, searched from a block onwards. */
  findAnchorLog(root: string, fromBlock: bigint): Promise<AnchorLog | null>;
}

export interface ChainWriter extends ChainReader {
  readonly submitter: string;
  /** Sends anchor(root). Resolves with the transaction hash once broadcast. */
  submit(root: string): Promise<string>;
  /** The receipt, or null if it did not arrive within the time allowed. */
  waitForReceipt(txHash: string, timeoutMs: number): Promise<Receipt | null>;
}

const abi = artifact.abi as Abi;
const ANCHORED = getAbiItem({ abi, name: "Anchored" });

function asBytes32(root: string): Hex {
  if (!/^[0-9a-f]{64}$/.test(root)) throw new Error("A root is 64 lowercase hexadecimal digits.");
  return `0x${root}`;
}

function fromBytes32(value: Hex): string {
  return value.slice(2).toLowerCase();
}

function chainFor(settings: ChainReadSettings) {
  return defineChain({
    id: settings.POLYGON_CHAIN_ID,
    name: settings.POLYGON_CHAIN_ID === 80002 ? "Polygon Amoy" : `Chain ${settings.POLYGON_CHAIN_ID}`,
    nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
    rpcUrls: { default: { http: [settings.POLYGON_RPC_URL] } },
  });
}

type Decoded = { args: { root: Hex; timestamp: bigint; submitter: string }; transactionHash: Hex; blockNumber: bigint };

function toAnchorLog(log: Decoded): AnchorLog {
  return { root: fromBytes32(log.args.root), txHash: log.transactionHash, blockNumber: log.blockNumber, timestamp: log.args.timestamp, submitter: log.args.submitter };
}

function reader(settings: ChainReadSettings) {
  const chain = chainFor(settings);
  const client = createPublicClient({ chain, transport: http(settings.POLYGON_RPC_URL, { timeout: config().ANCHOR_RPC_TIMEOUT_MS, retryCount: 1 }) });
  const address = settings.POLYGON_ANCHOR_CONTRACT_ADDRESS as Hex;
  const api: ChainReader = {
    chainId: settings.POLYGON_CHAIN_ID,
    contractAddress: address,
    blockNumber: () => client.getBlockNumber(),
    anchoredAt: (root) => client.readContract({ address, abi, functionName: "anchoredAt", args: [asBytes32(root)] }) as Promise<bigint>,
    async receiptLog(txHash) {
      const receipt = await client.getTransactionReceipt({ hash: txHash as Hex }).catch(() => null);
      if (!receipt) return null;
      const logs = parseEventLogs({ abi, logs: receipt.logs, eventName: "Anchored" }) as unknown as Array<Decoded & { address: string }>;
      const ours = logs.find((log) => log.address.toLowerCase() === address.toLowerCase());
      return ours ? toAnchorLog(ours) : null;
    },
    async findAnchorLog(root, fromBlock) {
      const logs = (await client.getLogs({ address, event: ANCHORED as never, args: { root: asBytes32(root) } as never, fromBlock, toBlock: "latest" })) as unknown as Decoded[];
      return logs.length > 0 ? toAnchorLog(logs[0]) : null;
    },
  };
  return { api, client, chain, address };
}

let override: { reader?: ChainReader | null; writer?: ChainWriter | null } = {};

/** Replaces the chain for tests. Pass nothing to go back to the configured one. */
export function useChain(fake?: ChainWriter | null): void {
  override = fake === undefined ? {} : { reader: fake, writer: fake };
}

/** Reads the chain, or null when the RPC, chain id or contract address is not set. */
export function chainReader(): ChainReader | null {
  if ("reader" in override) return override.reader ?? null;
  const settings = chainReadSettings();
  return settings ? reader(settings).api : null;
}

/** Writes to the chain, or null when the private key is not set as well. */
export function chainWriter(): ChainWriter | null {
  if ("writer" in override) return override.writer ?? null;
  const settings = chainReadSettings();
  if (!settings || !writerKeyPresent()) return null;
  const { api, client, chain, address } = reader(settings);
  const account = privateKeyToAccount(process.env.POLYGON_PRIVATE_KEY as Hex);
  const wallet = createWalletClient({ account, chain, transport: http(settings.POLYGON_RPC_URL, { timeout: config().ANCHOR_RPC_TIMEOUT_MS, retryCount: 1 }) });
  return {
    ...api,
    submitter: account.address,
    submit: (root) => wallet.writeContract({ address, abi, functionName: "anchor", args: [asBytes32(root)] }),
    async waitForReceipt(txHash, timeoutMs) {
      try {
        const receipt = await client.waitForTransactionReceipt({ hash: txHash as Hex, timeout: timeoutMs });
        return { status: receipt.status, blockNumber: receipt.blockNumber };
      } catch (error) {
        if (error instanceof Error && error.name === "WaitForTransactionReceiptTimeoutError") return null;
        throw error;
      }
    },
  };
}
