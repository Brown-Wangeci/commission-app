# Log evidence (Section G)

Captured 2026-11-09 against the app, built and started against the same
`ledgerfield_ch5` scratch database used for screenshots and the NFR-01 load
test. Everything here is a real run of the real code; nothing is a mock or a
hand-written transcript.

## 1. The scheduler firing T7

`01-scheduler-fires-t7.log` is the real stdout of `npx tsx scripts/scheduler.ts
--once`. `01-scheduler-fires-t7-activation.json` is that run's activation
(LF-000065), dumped through the real admin API (`/api/admin/review/{id}`,
`/api/admin/activations/{id}/audit`): submitted, scored T0 (auto_release,
2.2%), held, first-week activity reported, then the scheduler's T7 score
(auto_release, 0.1%) released it automatically and authorised its payout.

**`HOLD_WINDOW_SECONDS` was temporarily overridden to 15 seconds for this one
submission**, in place of the production default of 604,800 seconds (7 days,
the spec value in `app/.env.example`), purely so the hold window could close
inside this session instead of seven real days later. Nothing about the
scoring logic, the band thresholds, or the scheduler itself was changed; the
same code path that would fire after seven days in production fired here
after fifteen seconds. This is disclosed, not hidden, and is not a change to
any committed config.

An earlier attempt at this same capture, without reporting first-week
activity, produced a real T7 failure instead ("missing_input: no first-week
customer activity has been reported") -- a genuine failure mode, but not the
one this section asked for, so it was not kept as the primary artifact.

## 2. A scoring failure producing a could-not-be-scored decision

`02-scoring-failure-could-not-be-scored.json` is LF-000063's audit trail,
dumped the same way. The app was started with `SCORING_SERVICE_URL` pointing
at a closed port (`http://127.0.0.1:9`), the same technique
`prisma/seed.ts` uses for its own could-not-be-scored seed case. The
submission's T0 call failed with "unavailable"; the activation moved straight
to `in_review` so a reviewer could decide without the model, exactly like the
seeded case shown in `docs/chapter5/evidence/screenshots/figure-5-05-could-not-be-scored.png`.

## 3. An anchoring batch running

`03-anchoring-contract-deployment.log` is `npm run contract:deploy`'s real
stdout, deploying `AuditAnchor.sol` to a fresh local Anvil node (chain id
31337, Anvil 1.8.6, the same version named in `docs/chapter5/environment.md`)
started for this capture. `03-anchoring-batch-running.log` is
`npm run anchor:once`'s real stdout: one batch, sequences 1 to 742, Merkle
root `73b4d1f9...`, submitted and confirmed on chain in the same run
(transaction `0x1e996750...`, block 2).

This is a second local-Anvil run, separate from
`docs/chapter5/evidence/blockchain/local-anvil-2026-11-08` (Build 4's own
evidence, which IR-04 in `docs/chapter5/requirements_traceability.csv`
already cites). It exists only to show the anchoring batch actually running
during this session's log capture; it is not additional IR-04 evidence and
does not change IR-04's "partially met" status. The deployer is Anvil's
well-known default account 0; its private key is public Anvil test fixture
data, not a secret, and was used only against this throwaway local node.
