import { z } from "zod";

/**
 * Polygon settings, from the environment only. Reading the chain needs the
 * RPC URL, chain id and contract address; writing to it needs the private key
 * as well. Verification therefore works on any machine that can reach the
 * chain, with no key at all.
 *
 * The private key is read in one place, chainWriter() in chain.ts, and never
 * printed, logged or stored. The RPC URL is treated as secret too, because
 * hosted RPC URLs usually carry an API key.
 */
const readSchema = z.object({
  POLYGON_RPC_URL: z.string().url(),
  POLYGON_CHAIN_ID: z.coerce.number().int().positive(),
  POLYGON_ANCHOR_CONTRACT_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});

export type ChainReadSettings = z.infer<typeof readSchema>;

export function chainReadSettings(): ChainReadSettings | null {
  const parsed = readSchema.safeParse(process.env);
  return parsed.success ? parsed.data : null;
}

export function writerKeyPresent(): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(process.env.POLYGON_PRIVATE_KEY ?? "");
}

/** Names of missing or malformed settings for anchoring. Never values. */
export function missingChainSettings(): string[] {
  const parsed = readSchema.safeParse(process.env);
  const missing = parsed.success ? [] : [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
  return writerKeyPresent() ? missing : [...missing, "POLYGON_PRIVATE_KEY"];
}

/** Removes the private key and the RPC URL from any text that leaves this module. */
export function scrubChainText(text: string): string {
  const secrets = [process.env.POLYGON_PRIVATE_KEY, process.env.POLYGON_RPC_URL].filter((value): value is string => Boolean(value));
  const withoutSecrets = secrets.reduce((current, secret) => current.split(secret).join("[redacted]"), text);
  return withoutSecrets.replace(/0x[0-9a-fA-F]{64}(?=\b)/g, (match) => (match === process.env.POLYGON_PRIVATE_KEY ? "[redacted]" : match)).slice(0, 400);
}

/** Where to look a transaction up. Amoy and Polygon have public explorers; a local node has none. */
export function explorerBase(chainId: number, configured: string | undefined): string | null {
  if (configured) return configured.replace(/\/$/, "");
  if (chainId === 80002) return "https://amoy.polygonscan.com";
  if (chainId === 137) return "https://polygonscan.com";
  return null;
}
