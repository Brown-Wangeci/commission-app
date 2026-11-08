/**
 * Deploys contracts/AuditAnchor.json to the chain in POLYGON_RPC_URL, signing
 * with POLYGON_PRIVATE_KEY, and writes the address into
 * POLYGON_ANCHOR_CONTRACT_ADDRESS in the repository's root .env. Prints the
 * deployer address, the transaction hash and the explorer links; never the key.
 *
 * Usage: npm run contract:deploy [-- --evidence <dir>] [-- --no-env-write]
 *
 * --no-env-write leaves the root .env alone, for a throwaway local node.
 */
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadEnv } from "./load-env";

loadEnv();

const ROOT_ENV = path.resolve(__dirname, "..", "..", ".env");

function setRootEnv(name: string, value: string): void {
  const text = fs.existsSync(ROOT_ENV) ? fs.readFileSync(ROOT_ENV, "utf8") : "";
  const line = new RegExp(`^${name}=.*$`, "m");
  const updated = line.test(text) ? text.replace(line, () => `${name}=${value}`) : `${text.replace(/\s*$/, "")}\n${name}=${value}\n`;
  fs.writeFileSync(ROOT_ENV, updated);
}

async function main(): Promise<void> {
  const { explorerBase, scrubChainText } = await import("../src/lib/anchoring/credentials");
  const artifact = (await import("../contracts/AuditAnchor.json")).default as { abi: Abi; bytecode: Hex; compiler: string };
  const rpc = process.env.POLYGON_RPC_URL;
  const chainId = Number(process.env.POLYGON_CHAIN_ID);
  const key = process.env.POLYGON_PRIVATE_KEY;
  if (!rpc || !Number.isInteger(chainId) || !/^0x[0-9a-fA-F]{64}$/.test(key ?? "")) {
    throw new Error("Set POLYGON_RPC_URL, POLYGON_CHAIN_ID and POLYGON_PRIVATE_KEY in the root .env first.");
  }
  const chain = defineChain({ id: chainId, name: `Chain ${chainId}`, nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const account = privateKeyToAccount(key as Hex);
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });
  try {
    const balance = await publicClient.getBalance({ address: account.address });
    console.log(`Deployer ${account.address} on chain ${chainId}, balance ${balance} wei.`);
    const txHash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode });
    console.log(`Deployment transaction ${txHash}; waiting for the receipt.`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 180_000 });
    if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`Deployment ${txHash} did not succeed.`);
    const writeEnv = !process.argv.includes("--no-env-write");
    if (writeEnv) setRootEnv("POLYGON_ANCHOR_CONTRACT_ADDRESS", receipt.contractAddress);
    const base = explorerBase(chainId, process.env.POLYGON_EXPLORER_URL);
    const record = {
      chainId,
      compiler: artifact.compiler,
      deployer: account.address,
      contractAddress: receipt.contractAddress,
      transactionHash: txHash,
      blockNumber: String(receipt.blockNumber),
      gasUsed: String(receipt.gasUsed),
      transactionUrl: base ? `${base}/tx/${txHash}` : null,
      contractUrl: base ? `${base}/address/${receipt.contractAddress}` : null,
    };
    console.log(JSON.stringify(record, null, 2));
    const at = process.argv.indexOf("--evidence");
    if (at >= 0) {
      const dir = process.argv[at + 1];
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "01-deployment.json"), `${JSON.stringify(record, null, 2)}\n`);
    }
    console.log(writeEnv ? "POLYGON_ANCHOR_CONTRACT_ADDRESS written to the root .env." : "The root .env was left unchanged (--no-env-write).");
  } catch (error) {
    throw new Error(scrubChainText(error instanceof Error ? error.message : String(error)));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
