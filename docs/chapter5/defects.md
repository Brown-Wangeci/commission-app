# Defects found and fixed, with cause, fix and retest

Every entry below is drawn from a committed source: a change log, a notebook,
a code comment that documents the fix at the point it was made, or this
project's own build log. Nothing here is reconstructed from memory of a
session not recorded in those files. Where no dedicated regression test
exists for a defect, that is stated plainly rather than implied.

## 1. The pre-registration mix decomposition (Phase 4)

**What looked like a defect, and wasn't quite one.** After fixing the two
generator defects below (items 6 and 7), every XGBoost model's PR-AUC rose
and recall improved. Taken at face value this would read as "the fixes
improved the model." It does not.

**Cause.** Fixing the generator changes the random draws for every row after
the fix point, so the post-fix dataset is a *different realisation*, not the
same dataset with one column edited (`docs/change_log_phase4.md` section 4,
pre-registered before the fix was applied). The before/after comparison
therefore mixes the fix's real effect with ordinary realisation noise and a
genuine shift in the typology mix (sim farming +450 rows, ghost -342; sim
farming is the most detectable typology at 0.83 recall, ghost among the least
at 0.37).

**Analysis, not a code fix.** Two pre-registered methods separate the causes
(`docs/change_log_phase4.md` section 7b):
1. **Mix decomposition** (`outputs/before_after_mix_decomposition.csv`):
   overall recall at 90% precision rose by +0.027 total, of which **+0.044
   is the typology mix shifting** and **-0.017 is detection getting
   slightly worse**.
2. **Matched-seed control** (`outputs/realisation_control_prefix.csv`,
   `_postfix.csv`): the same model, same folds, seeds 42/7/101, run under
   both generators. Mean effect **-0.0146 PR-AUC**, negative at two of three
   seeds; seed 42 (the one the whole evaluation runs on) is the seed where
   it happened to rise.

**Retest.** The pre-registered predictions were scored against these exact
outcomes in `docs/change_log_phase4.md` section 7a: 6 of 16 numeric
predictions landed; every aggregate-level prediction (PR-AUC, the T0-T7 gap,
recall@90%, the false-positive composition) was wrong, in the direction the
mix decomposition explains. The honest statement of the Phase 4 result,
recorded there, is: *the reported improvement is not an improvement; the
underlying detection problem got slightly harder, and the headline numbers
rose because of which random dataset the generator fix happened to produce
at the one seed the project reports.*

## 2. Tornado figure: shared y-axis silently relabels one panel (Phase 6)

**Defect.** `src/eval/figures.py::tornado_figure` draws two side-by-side
panels (release threshold, reject threshold) sharing one y-axis
(`sharey=True`). If each panel computed its own bar ordering (for example,
ranking parameters by that panel's own threshold movement), the axis would
still show only one set of labels -- matplotlib's shared axis means the
*second* `set_yticks` call wins -- so the first panel's bars would be drawn
in one order while labelled with the second panel's order. The chart would
render without error and look plausible; the only way to notice would be to
hand-check a labelled bar against its source row.

**Fix.** Compute one ordering for both panels, ranked by the largest
absolute movement either threshold shows for that parameter, and use that
single order for every `set_yticks` call (`src/eval/figures.py`, the comment
immediately above `swing = singles.groupby(...)`: "One ordering for both
panels. With a shared y axis the second `set_yticks` call wins, so
per-panel orderings would label one panel with the other's rows.").

**Retest.** No dedicated automated regression test exists for this specific
figure-generation bug; it is guarded structurally, not by a test, since the
fix changed the code to compute a single ordering by construction rather
than fixing a comparison inside a loop. The retest consisted of inspecting
the rendered output (`outputs/figures/f3_sensitivity_tornado.png`) and
confirming both panels' bars line up with their printed labels against
`outputs/band_sensitivity.csv` by hand. This is recorded as a real
limitation, not glossed over: see `docs/chapter5/gaps.md`.

## 3. Mixed fractional-second timestamp precision (Phase 7)

**Defect, caught before it reached a committed bug report.** Timestamps
built from different sources (the generator's own output, and the JSON a
real scoring request carries) do not all carry the same number of
fractional-second digits. `pandas.to_datetime` infers a single fixed format
from the *first* value it sees in a column and applies that format to every
row; a column mixing, for example, `...12:00:00` and `...12:00:00.123456`
either raises or silently mis-parses the rows that do not match the format
inferred from the first row.

**Fix.** `src/serve/observable.py::_frame` parses every datetime column with
`format="ISO8601"` instead of letting pandas guess a fixed format, with the
reasoning recorded in the code itself: "format='ISO8601' (rather than
letting pandas guess a fixed format from the first value) copes with mixed
fractional-second precision across rows, which plain `to_datetime` does
not."

**Retest.** No dedicated unit test isolates this specific parsing behaviour
with a deliberately mixed-precision fixture. The surrounding correctness
test (`tests/test_serve.py::test_service_feature_vector_matches_training_pipeline`,
passing, see `docs/chapter5/test_cases.csv` TC-017, which also covers the
negative-control reimplemented-feature check in the same row) would fail if
datetime parsing broke the feature vector, but it does not specifically
exercise mixed fractional-second input. This is recorded as a real gap in
test coverage, not claimed as a tested regression: see `docs/chapter5/gaps.md`.

## 4. Stale `shap_worked_cases.csv` (final code session)

**Defect.** The committed `outputs/shap_worked_cases.csv` named different
worked examples (`act_0075269`/`act_0045764`/`act_0064891`, seeds
2024/7/42) than a fresh run of `src.eval.explanations` against the current
`outputs/multiseed_shap.parquet` produced (`act_0087637`/`act_0050289`/
`act_0063641`, seeds 7/7/101) -- the file had simply not been regenerated
after an earlier upstream change, even though the function that builds it
(the median-scoring activation of each band) is deterministic given fixed
inputs.

**Cause.** No reproducibility check existed to catch a committed output file
silently falling out of sync with the inputs that should have regenerated
it. Every other multiseed-derived output (PR-AUC by model, both band
operating points, per-typology recall, fairness by honesty) reproduced
identically in the same rerun, confirming the underlying data and model fits
were not the issue -- only this one file had gone stale
(`docs/results_index.md`, "Known stale or conflicting values").

**Fix.** Re-ran `python -m src.eval.explanations` (equivalently,
`python scripts/reproduce_all.py`) and committed the regenerated file.

**Retest.** Verified deterministic: running the explanation step twice in a
row on unchanged inputs gives byte-identical output (`docs/results_index.md`,
same section). The fix is the regenerated, now-current
`outputs/shap_worked_cases.csv` itself, cross-checked against
`outputs/multiseed_shap.parquet` in the same session.

## 5. The Phase 3 resampling comparison measured strength, not method

**Defect.** Phase 3 reported "SMOTE beats scale_pos_weight in 14 of 15
folds" as a comparison between two resampling *methods*. It compared SMOTE
oversampled to a minority ratio of 0.30 (about 4x) against
scale_pos_weight weighted to full balance (about 14x) -- two different
*strengths* of class-imbalance correction, not the same strength applied by
two different methods.

**Cause.** No control for the strength (effective minority ratio) each
method was run at; the comparison conflated "how hard the correction pushes"
with "which mechanism does the pushing."

**Fix.** Re-ran both methods, plus SMOTENC and a "none" arm, at every
effective ratio in a shared sweep (`outputs/resampling_sweep_summary.csv`,
full detail in `outputs/resampling_sweep_by_fold.csv`), with hyperparameters
chosen once by an inner search using no class handling at all, then held
fixed across every cell, so neither method's comparison is tuned to its own
favour.

**Retest -- the Phase 3 conclusion does not survive.** At matched strength
the methods are indistinguishable: at ratio 0.1, SMOTE scores 0.7803 against
scale_pos_weight's 0.7795; at ratio 1.0, 0.7684 against 0.7647. Every gap is
under 0.004, against a fold-to-fold standard deviation of 0.037. Both
methods fall steadily as the minority ratio is pushed up (0.780 at 0.1 down
to about 0.765 at 1.0), and doing nothing at all (`outputs/resampling_sweep_summary.csv`,
the "none" row at the natural ~0.077 ratio) scores best of any cell in the
sweep -- which is also why the deployed model (`t7_none`) uses no
resampling at all. (notebook `notebooks/02_model_results.ipynb`, "Resampling
compared at matched strength".)

## 6. Generator defect 1: held payout-gaming jobs had no honest counterpart

**Defect.** `config/generator.yaml` drew payout-gaming acceptance latency
from a distribution with a much longer tail (median about 12 hours for held
jobs) than every legitimate activation (median about 13 minutes), with no
honest behaviour pattern covering the gap. Realised
(`outputs/investigation_acceptance_latency_tail.csv`): above 12 hours
acceptance latency, the region was 93.3% fraud, with only 25 legitimate rows
out of 83,287 -- a near-deterministic separator for roughly a third of one
typology, violating the standing CLAUDE.md rule that every fraud signature
must have an overlapping legitimate counterpart.

**Cause.** The generator's `legitimate_lookalikes` had no entry for agents
who accept jobs as they arrive and work through them later (batch
acceptance around another job, or a multi-day event backlog).

**Fix.** Added that honest counterpart to `legitimate_lookalikes`, with its
share and distribution chosen on behavioural grounds only, never by looking
at the effect on any metric (`docs/change_log_phase4.md` section 1, "Fix
(B1)").

**Retest.** Regression-tested directly:
`tests/test_activity.py::test_held_jobs_have_honest_company_in_the_long_latency_tail`
(passing; see `docs/chapter5/test_cases.csv` TC-003). At the dataset level,
the generalised lookalike audit (`src/eval/lookalike_audit.py`) confirmed
both features this defect fed (`job_acceptance_latency_seconds`,
`submission_latency_seconds`) cleared from under 0.02% legitimate share to
2.23% and 2.95% respectively, with fraud purity falling from 96.8%/94.5% to
14.5%/11.5% (`docs/change_log_phase4.md` section 7c) -- cleared, though
landing below the pre-registered 4-12% prediction range, which is recorded
as a wrong prediction, not hidden.

## 7. Generator defect 2: careful payout-gaming rows could not disguise their timing

**Defect.** `src/generator/activity.py::_submission_hours` computed an hour
profile that honoured the "careful" mimicry path for every typology, then
unconditionally overwrote it for *every* payout-gaming row with
`cutoff_hour - offset`, regardless of whether that row was flagged careful.
A careful gaming activation could disguise its acceptance latency,
downstream behaviour and binary flags, but never its time of day -- silently
removing the generator's main source of hard cases (about 30% of gaming
rows) from the hard-case population on that one dimension.

**Cause.** The cutoff-hour override was applied unconditionally to the
typology, rather than being skipped for rows already mimicking on the timing
dimension, as every other typology's careful mechanism already did.

**Fix.** Scoped the override to apply only to payout-gaming rows that are
*not* mimicking on the timing dimension (`docs/change_log_phase4.md`
section 1, "Fix (B2)").

**Retest.** Regression-tested directly:
`tests/test_activity.py::test_careful_payout_gaming_can_disguise_its_timing`
(passing; TC-004). At the dataset level, payout-gaming recall at 90%
precision fell from 0.433 to 0.285 after both fixes together -- the intended
consequence, and, per `notebooks/02_model_results.ipynb`, "the number to
trust: the Phase 3 value was inflated by a defect."

## 8 and 9. The two Daraja bugs the mocked test suite could not catch (Build 3)

Both were found only by real calls to the Daraja sandbox, in
`docs/chapter5/evidence/mpesa/`; the mocked Daraja client used by the
automated suite (`app/tests/helpers/fake-daraja.ts`) always accepts a
well-formed request and never reproduces Safaricom's own real-world
response content, so neither bug could have been found without a live run.

### 8. Wrong B2C shortcode producing `ResultCode 2001`

**Defect.** The B2C request's `PartyA` (the paying shortcode) was set to
174379 -- the same shortcode configured for STK Push collection -- rather
than the business's actual B2C disbursement shortcode.

**Cause.** A configuration value (`MPESA_B2C_SHORTCODE`), not application
code; the mocked test suite has no way to detect a real-world credential
mismatch, because its fake Daraja client does not validate shortcode/
initiator consistency against anything.

**Fix.** The project owner corrected `MPESA_B2C_SHORTCODE`,
`MPESA_B2C_INITIATOR_NAME` and `MPESA_B2C_SECURITY_CREDENTIAL` in the root
`.env` to the business's real B2C credentials (`app/BUILD_LOG.md`,
"Follow-up: completing the sandbox evidence").

**Retest.** The next real sandbox run (`docs/chapter5/evidence/mpesa/
run-2026-11-08`) sent the corrected request and received `ResultCode 0`
(accepted) rather than 2001 on the B2C leg -- though it then met a second,
unrelated real-world refusal (`ResultCode 2040`, resolved separately; see
that evidence folder's README). The 2001 cause did not recur in any later
run.

### 9. `CheckoutRequestID` leaks the payer's phone number, unredacted

**Defect.** Daraja's real STK Push response includes a `CheckoutRequestID`
that ends with the payer's own phone number (observed directly in the first
real sandbox capture: `ws_CO_071120261159070708374149`, where the trailing
digits are the payer's MSISDN). `app/src/lib/payments/redact.ts` had no rule
for this field, so the payer's number would have been committed, unredacted,
into `docs/chapter5/evidence/mpesa/`.

**Cause.** No mock generates a realistic `CheckoutRequestID`, so nothing in
the automated suite could have surfaced this before a real call was made.
`app/BUILD_LOG.md`: "Found by the real run: Daraja's `CheckoutRequestID`
ends with the payer's number. A mock would never have shown this."

**Fix.** Added `maskCheckoutId` and a `CHECKOUT_KEY` redaction rule to
`app/src/lib/payments/redact.ts`, masking the trailing digits of any
`CheckoutRequestID` before it is logged, stored, or written to an evidence
file. The one already-committed capture that predated the fix was corrected
by hand, by the same masking rule, noted in that evidence folder's README.

**Retest.** `app/tests/payments-boundary.test.ts`, "No credential, signature,
or customer phone number survives the redaction pass" (passing; TC-085,
which includes the checkout-id masking case). The
full evidence tree was also scanned directly against the real phone numbers
used, in every run from that point on, not merely checked by pattern (see
`app/BUILD_LOG.md`, Build 3 and Build 3 follow-up verification sections).
