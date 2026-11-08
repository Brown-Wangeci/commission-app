# Blockchain anchoring evidence

## Status: anchored on a LOCAL chain, not on Polygon Amoy

**The run in `local-anvil-2026-11-08` used a local Anvil node (chain id 31337),
not the public Polygon Amoy test network.** No Amoy wallet credentials were
available when it was captured: the root `.env` had no `POLYGON_` settings. As
instructed for that case, the run used a local node with every interface
unchanged: the same contract bytecode, the same viem client, the same queue
and the same verifier the app uses against Amoy. There are therefore **no
Amoy explorer links**. Nothing here is on a public chain, and anyone wanting
public, third-party-checkable anchors must repeat the run on Amoy (below).

IR-04 names "Test on the test network" as its verification. A local node is not
that network, so IR-04 stays partially met until the Amoy run exists.

## local-anvil-2026-11-08

Anvil 1.8.6 (checksum verified against the Foundry release), contract compiled
with solc 0.8.37 for the paris EVM. The database was a scratch copy seeded
through the real scoring service, so the audit log holds the seed's real
history: 706 events, including a disputed submission.

| File | What it shows |
|---|---|
| `01-deployment.json` | The contract deployed: address, transaction, block, gas used. |
| `02-anchoring.json` | One batch, events 1 to 706, its RFC 6962 root, the transaction and block, and both read back from the chain: the contract's `anchoredAt(root)` and the root inside the transaction's `Anchored` event. |
| `03-verification-pass.json` | Disputed submission LF-000049: all 11 of its events recompute from their stored fields, link to their predecessors, prove into the batch's root, and the contract holds that root. The whole chain (707 events) verifies too. |
| `04-verification-tampered.json` | One event changed after anchoring: the agent's contest note on LF-000049 (event 548) rewritten to "the reviewer approved this". Verification fails at exactly that event: its stored fields no longer produce its recorded hash. |
| `05-verification-rewritten-chain.json` | The thorough attacker: the same change, plus every later stored hash (160 links) recomputed so the local chain is consistent again. The local chain check now passes, and verification still fails: the root recomputed from the stored events (`a243…`) is not on chain, and the transaction holds the original (`79e0…`). This is what anchoring adds. |
| `run-summary.json` | The three results: verified, failed, failed. |

The deployer is Anvil's first default account, a publicly known development
account. Its private key is not in any file here; the evidence was scanned for
it.

## To repeat the run on Polygon Amoy

1. Fund an Amoy wallet and set `POLYGON_RPC_URL`, `POLYGON_CHAIN_ID=80002` and
   `POLYGON_PRIVATE_KEY` in the root `.env`.
2. `npm run contract:deploy -- --evidence <dir>` writes
   `POLYGON_ANCHOR_CONTRACT_ADDRESS` into the root `.env` and the deployment
   record, with its explorer link, into the folder.
3. Seed a scratch database whose name starts with `ledgerfield_evidence`, then
   `DATABASE_URL=<it> npm run anchor:evidence -- <dir>`. The script refuses any
   other database, because it tampers with audit data on purpose.

The explorer links then appear in the JSON as
`https://amoy.polygonscan.com/tx/<hash>` and `.../address/<contract>`.
