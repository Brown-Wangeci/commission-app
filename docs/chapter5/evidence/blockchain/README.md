# Blockchain anchoring evidence

## Status: anchoring and verification ran on Polygon Amoy; the tamper test ran on a local node only

**Two sets of evidence exist, on two chains.**

- **Polygon Amoy (chain 80002), 2026-11-15:** `docs/chapter5/evidence/hosted/anchoring/`
  holds the deployment of `AuditAnchor` (`01-deployment.json`), one batch of 709
  audit events anchored in one transaction (`02-batch1-onchain.json`,
  `03-polygonscan-page-extract.txt`), and the verification of one activation's
  10 events against the root on chain (`verify-LF-000050.json`). Amoy is a test
  network, not Polygon mainnet.
- **Local Anvil node (chain id 31337), 2026-11-08:** the run in
  `local-anvil-2026-11-08`, described below. It was made first, when no Amoy
  wallet was available, with the same contract bytecode, viem client, queue and
  verifier the app uses against Amoy. It is the only place the tamper-detection
  tests (`04` and `05` below) were run. That is deliberate: the script that runs
  them (`npm run anchor:evidence`) rewrites audit events on purpose, so it
  refuses any database that is not a scratch one (name starting with
  `ledgerfield_evidence`), and the hosted database was never touched. No tamper
  test has been run against Amoy.

IR-04 names "Test on the test network" as its verification. Its current status
in `docs/chapter5/requirements_traceability.csv` is **met**, on the strength of
the Amoy evidence above.

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

## To run the tamper tests on Polygon Amoy as well

Steps 1 and 2 were already done for the hosted deployment (see
`../hosted/anchoring/`); they are repeated here only so that a scratch run
uses its own contract. Only step 3 has never been run against Amoy.

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
