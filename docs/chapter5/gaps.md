# Gaps and unevidenced items (this session)

Collection and measurement only, as instructed. Nothing below is invented to
fill a gap; each item states plainly what exists, what doesn't, and why.

## Measurements (A)

- **NFR-01's own rationale is not reproduced.** NFR-01 is motivated by
  "agents submit over mobile data." The load test in
  `docs/chapter5/environment.md` / `app/scripts/load-test.ts` runs entirely
  over loopback (127.0.0.1), with no real network latency, no mobile
  network conditions, and no reverse proxy. The 100-concurrent-user,
  2-second figures reported are real, but they measure this one machine's
  application and database layer, not what an agent on mobile data would
  experience.
- **NFR-02 is a sample, not the full dataset.** A full pass over the
  dataset's roughly 90,000 activations, in both modes, at the multi-second
  per-call cost actually measured, would take on the order of a day of
  wall-clock time. `scripts/measure_scoring_latency.py` samples 200
  activations per mode (400 calls total) with a fixed seed, stated plainly
  in the script's docstring and in `docs/chapter5/environment.md`, rather
  than claiming full-dataset coverage.
- **Neither measurement is against a hosted deployment.** There is none.
  Both are against the one developer machine described in
  `docs/chapter5/environment.md`.
- **NFR-02's 1-second target is not met.** The real measured round trip
  (`docs/chapter5/evidence/performance/nfr02-scoring-latency.json`, n=400,
  2026-11-09) is mean 1.662s, p95 4.026s, max 7.111s; only 28.75% of calls
  land within 1 second. This is reported as-is per the instruction to report
  real numbers whether or not the target is met, and nothing was tuned to
  improve it. `docs/chapter5/requirements_traceability.csv` marks NFR-02
  "not met" for this reason.

## Blockchain anchoring (B)

- **IR-04's verification method ("Test on the test network") is not fully
  met.** The audit-anchor contract was deployed and exercised on a local
  Anvil node, not Polygon Amoy, because no funded Amoy wallet was available
  at any point in this project. The contract, the client code, the queue
  and the verifier are all unchanged between a local node and Amoy; only
  the chain differs. `docs/chapter5/requirements_traceability.csv` marks
  IR-04 "partially met" for this reason, and
  `docs/chapter5/evidence/blockchain/README.md` gives the exact two
  commands (`npm run contract:deploy`, `npm run anchor:evidence`) that would
  repeat the same run on Amoy once a wallet exists.

## Defects (E)

- **Two defects have no dedicated regression test.** The tornado-figure
  ordering bug (`docs/chapter5/defects.md` item 2) is guarded structurally
  (the fix computes one shared ordering by construction, rather than fixing
  a comparison that could regress) rather than by an automated test; its
  retest was a hand check of the rendered figure against
  `outputs/band_sensitivity.csv`. The mixed-precision timestamp bug (item 3)
  is covered only indirectly, by the feature-vector-equivalence test, which
  would fail if datetime parsing broke the feature vector but does not
  specifically exercise mixed fractional-second input. Both are stated as
  gaps in `docs/chapter5/defects.md` itself, not glossed over here.

## Test traceability (D)

- **Correction (2026-11-09): FR-09 was wrongly recorded as untested.**
  `app/tests/capture-form.test.tsx` (existing since 2026-10-29, cited all
  along in `docs/chapter5/requirements_traceability.csv`'s own FR-09 row) was
  missed when `docs/chapter5/test_cases.csv` was first built; it renders
  `EvidenceFieldInputs.tsx` from two different job configurations and asserts
  on the output, exactly what this gap previously said was missing. Now
  TC-108 in `test_cases.csv`; re-run and confirmed passing (4/4) this
  session. No requirement marked "met" is without a test row.
- **A handful of committed tests have no numbered Chapter 4 requirement to
  cite.** `test_config.py` (config-hash integrity), most of
  `test_phase5.py` (the cost-model and calibration mechanics that produce
  the operating thresholds), `route-errors.test.ts` and `api-live.test.ts`
  (issue #18's consistent-error-shape guarantee), and `auth.test.ts`'s route
  policy beyond NFR-05/NFR-06 are marked `requirement_id = N/A` in
  `docs/chapter5/test_cases.csv` rather than attached to a requirement they
  do not actually test.
- **Grouping.** 383 vitest `it()` blocks and 150 pytest test functions are
  represented as 107 rows, grouped by describe-block or by tight thematic
  similarity, each row's `count` column stating how many individual checks
  it stands for. A reviewer wanting the individual assertion should read the
  cited test file at the stated name.

## Screenshots (F)

- **Correction (2026-11-09): the agent submission form is now captured.**
  (figure-5-15, figure-5-16). The fresh seed has no unsubmitted accepted
  assignment, so one assignment was created through the real API and then
  accepted through the real UI for this capture; see
  `docs/chapter5/evidence/screenshots/captions.md` for exactly what was done.
  All 14 requested figures (plus one extra mobile-width capture) are now
  present.
- **A real rendering issue was found, not fixed.** In
  `figure-5-02-admin-review-queue.png`, the payout-breakdown text for one row
  (LF-000049) wraps one character per line at the 1360x900 viewport used for
  capture. This is collection and measurement only, so it is reported here
  rather than patched.
- **The blockchain-dependent figures (audit log, dispute verification) show
  an unconfigured chain**, because this capture ran without
  `POLYGON_RPC_URL`/`ANCHOR_CONTRACT_ADDRESS` set, consistent with the rest of
  this session. The dispute verification result is therefore "partly
  verified" (hash chain recomputes correctly; nothing to check on chain yet),
  not the fully-anchored result Build 4's own local-Anvil evidence
  (`docs/chapter5/evidence/blockchain/`) already demonstrates separately.

## Logs (G)

- **`HOLD_WINDOW_SECONDS` was overridden to 15 seconds for one capture.** The
  scheduler-firing-T7 log (`docs/chapter5/evidence/logs/01-scheduler-fires-t7.log`)
  needed the hold window to close inside this session rather than after the
  real 7-day production value. No scoring, banding or scheduler code was
  changed; only this one env var, for one submission, disclosed in
  `docs/chapter5/evidence/logs/README.md`.
- **The anchoring-batch log is a second, separate local-Anvil run**, not
  additional IR-04 evidence. It exists only to show the batch mechanism
  running during this session; Build 4's own local-Anvil evidence
  (`docs/chapter5/evidence/blockchain/local-anvil-2026-11-08`) remains what
  IR-04 cites, and IR-04 stays "partially met" for the reason already given
  above.

## Follow-up corrections (2026-11-09, second pass)

- **No committed "~45x" honest-with-lookalike-vs-no-lookalike refusal
  ratio was found.** Searched `outputs/`, `notebooks/`, and `docs/model_card.md`.
  The closest committed numbers are in `outputs/fairness_bands_by_situation.csv`:
  honest agents with no lookalike situation are held (review + reject) 0.073%
  of the time, against roughly 2.7-3.0% for agents in the `dormant`,
  `shared_device` or `batch_acceptance` situations -- which a reader could
  divide to get a ratio in the high-30s to low-40s depending on which
  situation is chosen, but no single committed figure states "~45x," and
  this session computed no new ratio to fill that gap, per instruction.
  `docs/model_card.md` and the Part E4 notebook cell both instead cite the
  agent-type ratio (~11.6x, systematic vs. honest, already in table 9 /
  the Fairness section above) and describe the post-correction change in
  prose ("fell by about three quarters"), not a lookalike-situation ratio.
- **FR-09 test coverage, the agent-submission-form screenshot, two
  mislabeled table-8 figures, the "roughly halved" fairness claim, and
  NFR-08's F1 evidence were all corrected this pass** -- see the inline
  "Correction" notes above and in `docs/chapter5/results_tables.md` /
  `docs/results_index.md` for what changed and why.
