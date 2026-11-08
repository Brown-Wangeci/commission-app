import type { AuditAnchor } from "@prisma/client";
import type { Tx } from "@/lib/db";
import { chainReadSettings, explorerBase, missingChainSettings } from "./credentials";
import { config } from "@/lib/config";

/** What an administrator needs to see about the chain and its anchoring. */
export type AnchoringStatus = {
  chainLength: string;
  anchoredThrough: string;
  awaitingBatch: string;
  open: AuditAnchor | null;
  recent: Array<AuditAnchor & { txUrl: string | null }>;
  configured: boolean;
  missing: string[];
  chainId: number | null;
  contractUrl: string | null;
};

export async function anchoringStatus(db: Tx): Promise<AnchoringStatus> {
  const [head, lastConfirmed, open, recent] = await Promise.all([
    db.auditChain.findFirst({ orderBy: { sequence: "desc" }, select: { sequence: true } }),
    db.auditAnchor.findFirst({ where: { status: "confirmed" }, orderBy: { toSequence: "desc" } }),
    db.auditAnchor.findFirst({ where: { status: { not: "confirmed" } }, orderBy: { fromSequence: "asc" } }),
    db.auditAnchor.findMany({ orderBy: { fromSequence: "desc" }, take: 10 }),
  ]);
  const settings = chainReadSettings();
  const lastBatched = (await db.auditAnchor.findFirst({ orderBy: { toSequence: "desc" }, select: { toSequence: true } }))?.toSequence ?? 0n;
  const length = head?.sequence ?? 0n;
  const base = (chainId: number) => explorerBase(chainId, config().POLYGON_EXPLORER_URL);
  return {
    chainLength: String(length),
    anchoredThrough: String(lastConfirmed?.toSequence ?? 0n),
    awaitingBatch: String(length - lastBatched),
    open,
    recent: recent.map((anchor) => {
      const explorer = base(anchor.chainId);
      return { ...anchor, txUrl: explorer && anchor.txHash ? `${explorer}/tx/${anchor.txHash}` : null };
    }),
    configured: missingChainSettings().length === 0,
    missing: missingChainSettings(),
    chainId: settings?.POLYGON_CHAIN_ID ?? null,
    contractUrl: settings && base(settings.POLYGON_CHAIN_ID) ? `${base(settings.POLYGON_CHAIN_ID)}/address/${settings.POLYGON_ANCHOR_CONTRACT_ADDRESS}` : null,
  };
}
