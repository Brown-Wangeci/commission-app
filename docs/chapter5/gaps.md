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

- **Anchoring ran on Polygon Amoy; what remains is the tamper test and
  mainnet.** The audit-anchor contract was first deployed and exercised on a
  local Anvil node (`docs/chapter5/evidence/blockchain/local-anvil-2026-11-08`)
  because no funded Amoy wallet was available. On 2026-11-15 the same contract
  was deployed to Polygon Amoy (chain 80002), one batch of 709 audit events was
  anchored (transaction `0x50f11819...ddba9`, status success), and one
  activation's 10 events were verified against the root on chain
  (`docs/chapter5/evidence/hosted/anchoring/`: `01-deployment.json`,
  `02-batch1-onchain.json`, `verify-LF-000050.json`). The tamper-detection
  test (`04-verification-tampered.json`) was run only on the local node, which
  is deliberate: that run rewrites an audit event on purpose, and doing it
  against the hosted database would have altered the hosted record. No
  tamper test was run against Amoy. Amoy is a test network, not Polygon
  mainnet. `docs/chapter5/requirements_traceability.csv` marks IR-04 and
  FR-21 "met" on this basis.

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

- **Reversals are not handled (defect 14).** On 2026-11-16 the Daraja sandbox
  reversed a KSh 10 STK payment about 50 minutes after completing it. The app
  has no handling for reversals and is told nothing about them. Funding is
  credited only by a verified callback, so a late success from a status check
  cannot create a credit, but a reversal after a credit would leave the
  balance credited. Production behaviour is not established; no Safaricom
  documentation was found. Not built, by decision.
- **The hosted M-Pesa callbacks of 2026-11-15 are unexplained.** Two STK
  Pushes and one B2C payout were accepted by Daraja and produced no callback.
  A later experiment shows callbacks reaching both a tunnel and the hosted
  origin within seconds, so the cause is not a blocked or unreachable origin.
  A delay on Safaricom's side is the leading explanation and is not proven
  (`docs/chapter5/evidence/hosted/mpesa/callback-delivery-experiment.md`).
  On 2026-11-23 a hosted STK Push and a hosted B2C payout each received their
  callback within seconds and settled with ResultCode 0, with no status query
  (`docs/chapter5/evidence/hosted/step18/`). That shows delivery to the hosted
  origin works; it does not explain 15 November. Only the success path was
  run: no hosted failure, retry or reconciliation was exercised on that day.

- **Reconciliation is shown on the hosted app only for a failed funding
  attempt that Daraja answered with a non-success, an unanswered check, and a
  payout query.** It has not been seen raising a late `ResultCode 0` against the
  real service: the check on the first KSh 10 push answered HTTP 429 at
  13:43 UTC on 2026-11-16, and the next one is an hour later
  (`docs/chapter5/evidence/hosted/mpesa/reconciliation-armed.md`).
- **The Linux (CI) build of the scoring artifacts was not compared with the
  published ones.** The question of whether the ubuntu build scores like the
  local and Render builds is unanswered. A throwaway Linux build was not
  permitted, the cause of the platform difference is not established, and the
  item is dropped by decision rather than resolved
  (`docs/chapter5/evidence/hosted/scoring/model-comparison.md`).

## Usability pass (2026-11-16)

- **No user has tried it.** The changes were judged by their author against the
  eight goals in the brief, by reading the recaptured screens and by the checks
  in `docs/chapter5/evidence/usability/`. No agent, client or reviewer used the
  new screens, so "less overwhelming" and "next action obvious" are not
  measured.
- **The password rule's numbers are assumptions.** A minimum of 8 characters
  and three of four character classes are stated as assumptions in
  `password-rules.ts`. There is no check against common or breached passwords
  (a first version had a short hand-written list; it was removed by decision),
  so "Password1!" is accepted. The rule applies at sign-up only; there is no
  password-change screen.
- **Confirm-password is checked in the form only.** The API takes no
  confirmation field, so a client posting to `/api/auth/signup` directly is held
  to the rule but not asked to confirm.
- **The interactive behaviour has no automated test.** The suite has no DOM
  environment, so the show/hide toggle, the live rule list, a section opening
  from a link and the sticky summary are checked by `app/scripts/verify-usability.js`
  in a real browser, run by hand on 2026-11-16, not by CI. Component
  structure, order and wording are covered by tests that render markup or read
  source, which can pass while a style is wrong.
- **The wording for a missing first week was not captured.** The seed has no
  hold-close activation that failed for lack of first-week activity, so no
  screenshot shows that sentence; a database test covers it.
- **Defaults are assumptions.** Ten activations, a 30-day deadline, a 10% rate
  and a 700 m radius on the post-a-job form are conveniences, not figures from
  the project's specification or a partner.
- **The Chapter 4 wireframes were not regenerated**, as instructed, so they
  describe the earlier layouts of the screens changed here.
- **One local pytest run failed once** (`test_score_then_explain_returns_both_records_in_time_order`)
  while the vitest suite was running at the same time on the same machine; it
  passed alone and CI is the record. Python code was not changed.

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
- **Grouping.** 383 passing vitest `it()` blocks (plus 38 skipped without a
  live server -- see `docs/chapter5/environment.md` for the full list) and
  162 pytest test functions, confirmed by the CI run on this branch
  (`.github/workflows/ci.yml`, runs 43040371977 and 43040381579 on commit
  976b5ef, 2026-11-11), are represented as 109 rows, grouped by
  describe-block or by tight thematic similarity, each row's `count` column
  stating how many individual checks it stands for. The 109th row, TC-109,
  is the 12 tests in `tests/test_curated_records.py`, which were not
  committed when the earlier 150-test run was recorded. A reviewer wanting
  the individual assertion should read the cited
  test file at the stated name.

## Screenshots (F)

- **Correction (2026-11-09): the agent submission form is now captured.**
  (figure-5-15, figure-5-16). The fresh seed has no unsubmitted accepted
  assignment, so one assignment was created through the real API and then
  accepted through the real UI for this capture; see
  `docs/chapter5/evidence/screenshots/captions.md` for exactly what was done.
  All 14 requested figures (plus one extra mobile-width capture) are now
  present; all 16 were recaptured on a fresh seed on 2026-11-11 after the
  restyle.
- **Fixed (2026-11-11, branch `accrue-restyle`): the payout-column wrap.**
  In the 2026-11-09 `figure-5-02-admin-review-queue.png`, the payout-breakdown
  text for one row (LF-000049) wrapped one character per line at the
  1360x900 capture viewport. The restyle gives the payout column a minimum
  width, keeps each amount on one line, and lets the working wrap only
  between words; the recaptured figure-5-02 shows it over six readable lines,
  with the whole queue table fitting the viewport. Presentation only: no
  change to how the payout is computed.
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

## Client review setting (2026-11-25)

- **It does not send literally every submission to a reviewer.** A hold-close
  reject is still refused automatically (the agent may contest it), and
  submissions that could not be scored follow their earlier path.
- **The setting is read when the decision is made.** Turning it off releases
  activations still on hold that score `auto_release`; there is no snapshot of
  the setting at submission.
- **The rules are enforced by the application, not the database.** Nothing in
  the schema stops a payout authorisation with no reviewer, or a change to a
  job's own choice. The app offers no way to change that choice after
  publication.
- **The agent is not told.** The held-activation text still says the submission
  is checked again and then paid, sent to a reviewer, or refused, and nothing on
  the agent's screens mentions the setting.
- **Clicking the toggle has no automated test.** The suite has no DOM
  environment; it was clicked in a local browser by a script run by hand on
  2026-11-25 (stored value and audit events checked), not by CI.
- **The hosted check covers one path.** On 2026-11-25 a hold-close
  `auto_release` with the account setting on went to review with no payout
  authorised (`evidence/hosted/client-review/`). The setting off, a per-job
  override, a reviewer's decision and the two form controls were not exercised
  on the hosted app.

## Accessibility audit (2026-11-25)

- **The target-size criterion is not from WCAG 2.1.** IR-10 names WCAG 2.1 AA,
  which has no target-size criterion; the 24 px rule of WCAG 2.2 was applied.
  The 44 px level AAA size is not met by many controls.
- **Automated, plus judgements by reading the code.** No person used the screens
  and no assistive technology was tried. The risk scale is judged to pass
  because its values are also written as text.
- **Coverage.** Chromium at 360 px and 1366 px. The agent's evidence-response,
  contest and withdraw forms were audited locally only; hover, focus and error
  colours are covered by the token test, not rendered; error pages were not
  audited (`evidence/accessibility/README.md`).
- **The audit is not run by CI.** CI holds the token colours; a new screen that
  breaks contrast in some other way is found only by running the script.
