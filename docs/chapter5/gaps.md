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

- **FR-09 ("render the agent form from the configuration") has no dedicated
  automated test in either committed suite.** `app/tests/evidence-fields.test.ts`
  thoroughly tests validation *against* a configuration, and
  `app/tests/layer-boundary.test.ts` tests what reaches the model, but
  nothing in the committed suites renders `EvidenceFieldInputs.tsx` and
  asserts on its output. `docs/chapter5/test_cases.csv` therefore has no row
  for FR-09, and this is the one "met" requirement that instruction D's
  "every requirement marked met must appear at least once" rule cannot be
  satisfied for honestly.
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

- **Agent submission form was not captured.** The fresh seed's assignments
  are each either unaccepted or already submitted, so there was no
  in-progress submission to screenshot without performing a new submission
  outside the seed's own data (which would not be "seeded data" in the sense
  the brief asked for). 13 of the 14 requested figures were captured; this
  one is listed, not faked. See `docs/chapter5/evidence/screenshots/captions.md`.
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
