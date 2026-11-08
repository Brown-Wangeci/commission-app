import fs from "node:fs";
import path from "node:path";
// solc-js has no type declarations.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const solc = require("solc") as { compile(input: string): string; version(): string };

export type AnchorArtifact = {
  contractName: "AuditAnchor";
  compiler: string;
  settings: { optimizer: { enabled: boolean; runs: number }; evmVersion: string };
  sourceSha256: string;
  abi: unknown[];
  bytecode: `0x${string}`;
  deployedBytecode: `0x${string}`;
};

const SOURCE = path.resolve(__dirname, "..", "contracts", "AuditAnchor.sol");
const SETTINGS = { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris" };

type Output = {
  errors?: Array<{ severity: string; formattedMessage: string }>;
  contracts: Record<string, Record<string, { abi: unknown[]; evm: { bytecode: { object: string }; deployedBytecode: { object: string } } }>>;
};

/** Compiles the contract with the pinned compiler and fixed settings. */
export function compileAnchor(): AnchorArtifact {
  const source = fs.readFileSync(SOURCE, "utf8").replace(/\r\n/g, "\n");
  const input = {
    language: "Solidity",
    sources: { "AuditAnchor.sol": { content: source } },
    settings: { ...SETTINGS, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } } },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input))) as Output;
  const errors = (output.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  const contract = output.contracts["AuditAnchor.sol"].AuditAnchor;
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return {
    contractName: "AuditAnchor",
    compiler: solc.version(),
    settings: SETTINGS,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}`,
    deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
  };
}
