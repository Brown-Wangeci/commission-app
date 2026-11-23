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

## 10 to 14. Found by the hosted M-Pesa test, 15 to 16 November 2026

**What happened.** On the hosted system two STK Push attempts of KSh 10
(13:08 and 13:17 EAT on 15 November) were accepted by Daraja, and no callback
reached the app. The app asked Daraja for the result three times each and
marked both attempts failed (22 and 30 minutes after they were made), with
"No result from M-Pesa after 3 checks." About 20 hours later (09:10 EAT on
16 November) Safaricom completed the first one: the payer's phone shows KSh 10
debited, then reversed at 10:00 EAT. Daraja's STK Query for it now answers
`ResultCode 0`, "processed successfully", while the app still holds it as
failed, with no alert to an administrator. Separately, the KSh 10 B2C payout
for LF-000064 was accepted by Daraja on 15 November and is still
`unconfirmed`: no result or status callback was ever received for it.

**What is not known.** Why no callback came. A controlled experiment on
16 November (`docs/chapter5/evidence/hosted/mpesa/callback-delivery-experiment.md`)
shows Daraja delivering a callback within about 10 seconds both to a
temporary tunnel and to the hosted `vercel.app` origin, and Vercel's firewall
denied nothing. So the origin is reachable, and the missing callbacks look
like a delay on Safaricom's side that the app cannot see. The five items
below are about what the app did with that uncertainty.

### 10. A status check Daraja did not answer used up one of the three checks

**Defect.** An STK status check that got HTTP 429 ("Daraja is unavailable"),
a timeout, or `500.001.1001` ("being processed") counted as one of the three
allowed checks. Rate limiting alone could therefore end a funding attempt as
failed, "No result from M-Pesa after 3 checks", although Daraja had never
answered. The payout queue had the same flaw. `Retry-After` was never read.
No money was at risk: nothing is credited without a verified callback, and a
status check never sends anything. The harm was a wrong, premature failure
shown to the client, and an unconfirmed payout raised without Daraja ever
having been asked.

**Cause.** `claimStatusCheck` (`funding.ts`, `disbursement.ts`) increased
`queryCount` when it claimed the row, before the query was made, and the
limit was a count of claims, not of answers.

**Fix.** `queryCount` now counts only a result Daraja gave (funding) or a
query it accepted (payout). A check with no answer is recorded, adds to
`noAnswerCount`, and waits 60 s doubling to 16 min, or the `Retry-After`
Daraja sent if longer, capped at 900 s. Waiting is bounded by time instead of
by a count: funding is marked failed after `FUNDING_GIVE_UP_AFTER_SECONDS`
(1500, replacing `FUNDING_MAX_STATUS_QUERIES`), and a payout is raised after
`PAYMENT_MAX_STATUS_QUERIES` accepted queries or
`PAYMENT_ESCALATE_AFTER_SECONDS` (7200), whichever is first. All new
parameters are assumptions in `app/.env.example`. An answered failure still
ends an attempt at once. The claim now moves the due time a lease ahead, so
two workers still cannot ask twice. Guarantees unchanged: nothing is credited
by a status check; nothing is sent again.

**Retest.** `app/tests/funding.test.ts`, "a status check Daraja does not
answer" (429 and `Retry-After`, cap, doubling, 504, answered failure,
never credits) and the rewritten "gives up after the time limit, not after a
count"; `app/tests/disbursement.test.ts`, "does not use up a query on HTTP
429", "raises it after the time limit even when Daraja never takes a query";
`app/tests/status-check-rules.test.ts`.

### 11. Daraja's answer to each check was thrown away

**Defect.** Only the latest `lastError` was kept, and the give-up message
replaced it. After the hosted failure it was not possible to say what Daraja
had answered to each of the three checks. Scoring has an append-only
`ScoringAttempt` table; payments had nothing.

**Fix.** A new append-only table, `PaymentStatusCheck` (migration
`20261116120000_payment_status_checks`): one row per check, for funding and
payouts, with the purpose, Daraja's classification, HTTP status, its code,
its words (redacted and cut to 300 characters), `Retry-After`, whether it
used a check, and when the next one was scheduled. A trigger refuses any
update or delete, and a constraint makes each row name exactly one funding
attempt or disbursement.

**Retest.** `funding.test.ts`, "a record of every answer" (one row per check
with the right fields, update and delete refused, no phone number kept, a row
with no subject refused); `disbursement.test.ts` ("records the answer").

### 12. Nothing asked Daraja again after the app gave up

**Defect.** After a funding attempt was marked failed without an answer, or a
payout was raised as unconfirmed, the queues stopped asking. The first
attempt above is the example: Daraja now says it succeeded, and the app still
says failed. A payment that completes late could only be noticed if its
callback arrived.

**Fix.** Reconciliation. When funding is marked failed without an answer, or a
payout is raised, the row gets a deadline (`RECONCILE_PERIOD_SECONDS`, 48
hours, which covers the 20 hours seen) and Daraja is asked every
`RECONCILE_INTERVAL_SECONDS` (1 hour) until then. A failure that M-Pesa itself
reported by callback is not reconciled. Asking never sends anything.

- **Funding: raised, not applied.** If Daraja says `ResultCode 0`, the attempt
  is raised to every administrator and nothing is credited. Chosen because a
  status answer carries no receipt and no amount, and the deposit trigger and
  the unique-receipt guard both need a receipt; because credit only through a
  verified callback is an existing guarantee with its own test; and because
  this very case shows the risk: Daraja still answered "processed
  successfully" for a payment its sandbox reversed 50 minutes later, so
  crediting from a status answer would have created KSh 10 of escrow with no
  money behind it. A late verified callback still credits, once (the same
  path as before).
- **Payouts: recorded and raised.** The answer to a status query arrives by
  callback and is applied by the existing verified path, which has the receipt
  and amount. Each query is recorded, and when a payout that had been raised
  settles as paid, administrators are told, so that nobody pays it by another
  route. A failure was already raised.

**Done by hand on 16 November 2026.** The rows already in the hosted database
(the two failed KSh 10 attempts and LF-000064) were made before this change and
had no deadline. A deadline was set on those three rows with
`app/scripts/arm-reconciliation.ts`, and the hosted cron asked Daraja about each
at once. Its answers (a definite non-success, an unanswered HTTP 429, an
accepted payout query) are in
`docs/chapter5/evidence/hosted/mpesa/reconciliation-armed.md`. Rows made after
the change are armed by the app itself.

**Retest.** `funding.test.ts`, "reconciling after giving up" (slow interval,
stops at the deadline, success raised and nothing credited, a late callback
credits once, a Daraja failure closes it, a callback failure is not asked
about, two workers ask once); `disbursement.test.ts`, "keeps asking after it is
raised", "a Completed result for a raised payout settles it once", "a Declined
result". Every payout test asserts that B2C is sent exactly once.

### 13. The audit log held the full payout number

**Defect.** The `payout_authorised` audit event wrote the agent's full M-Pesa
number into its text. The audit log is append-only, shown to every
administrator, and requirement NFR-13 asks for the number to be masked except
in a dispute or failed payout. This was found when a diagnostic query printed
an event's text.

**Fix.** `app/src/lib/payouts/authorise.ts` now writes the number masked
(`07******000`), with the same `maskPhone` used for logs. **Existing events
are not altered**: the table is append-only and hash-chained, and changing one
would break verification and the batches already anchored. On the hosted
database, before the fix, **50 of 773 audit events** held a full number (all
`payout_authorised`, five distinct numbers); none of the 61 notifications did.
Those 50 remain. NFR-13's other gap, the number in full on four admin
screens, is unchanged.

**Retest.** `disbursement.test.ts`, "authorising a payout records the number
masked, never in full".

### 14. Reversals are not known to the app (known limitation, not fixed)

**Observed.** The sandbox reversed the KSh 10 about 50 minutes after
completing it. The app has no concept of a reversal and receives nothing
about one.

**Why it is not built.** By decision. What protects the books today is that
funding is credited only by a verified callback, never by a status answer
(defect 12). What is not covered: if Daraja reverses a payment after the app
has credited it, the escrow balance stays credited. Whether a production
reversal can happen, and how it would be reported, is not established here:
the behaviour was seen once, in the sandbox, and no Safaricom documentation
on it was found.

**Retest.** None. Listed in `docs/chapter5/gaps.md`.

## 15. Found while making the usability pass, 16 November 2026 (caught before merge; none was in a released build)

The pass moved content into sections that open on click and regrouped screens.
Each item below was found by looking at the recaptured screens or by running
the browser, not by a failing automated test, and each now has a regression
check.

- **A collapsed section hid what a reviewer needs.** With the history inside a
  closed section, the awaiting-evidence screen no longer showed what the agent
  had been asked for. Fixed with a "Waiting for the agent" block above the
  concern, showing who asked, when and what. Retest: `app/tests/usability.test.tsx`
  (item 3) and figure-5-04.
- **A collapsed audit record made the capture script's Verify click miss.**
  Figure 10 was captured without its verification result, and the script did
  not fail. The script now opens the section first. Retest: figure-5-10.
- **A link to a closed section would not have opened it.** The Next.js `Link`
  to `#location` changes the address with `history.pushState`, which does not
  raise `hashchange`, so "Show the location on a map" would have scrolled to
  nothing. Links to places on the same page are plain anchors, and the section
  opens on `hashchange`. Retest: `usability.test.tsx` (source checks) and
  `app/scripts/verify-usability.js` (opens by address, run in a browser).
- **A unitless line height made each dashboard group card about 570 px tall.**
  Caught on the first capture; fixed with a length. Retest: usability-01.
- **The touch-target script assumed an activation the seed no longer has.** It
  looked for a refused activation in Mercy's list; the current seed gives that
  case to Samuel, so the script stopped. It now falls back to Samuel's list for
  that one page and says so in its output. Retest: `nfr12-touch-targets.json`.
- **Tests used a password the new rule refuses.** Four sign-up tests in
  `app/tests/auth.test.ts` used `a-long-password` (two character classes). They
  now use `Long-Password-42`. The assertions are unchanged.

No test asserted on any wording or layout the pass changed, other than the four
password fixtures above.

## 16. Phone-camera photos exceed the platform's request limit, 23 November 2026

**What happened.** On the hosted app two photos from an Android phone camera
(capture forced, so no file picker) made the submission fail. The agent saw only
"Request failed (413)." with nothing to act on.

**Cause.** Vercel refuses a request body over about 4.5 MB before the app runs.
The form sent each photo at the size the camera produced (3 to 8 MB), and the
only server-side limit was 8 MB per file with no total, so a request could pass
the app's check and still be refused by the platform. The platform's 413 has no
JSON body, so the form's message fell back to the status number. Tests could
not catch it because they upload small fixtures, and the local setup has no
such limit.

**Fix.**
- Each photo is scaled and re-encoded in the browser before upload: longest
  side at most 1600 px, JPEG quality 0.8 (`app/src/lib/evidence/photo-resize.ts`,
  limits in `photo-limits.ts`). The per-photo capture time stamp is taken from
  the original file and the shrunk file keeps its modified time; the location
  stamp is unchanged. The camera-only input (`capture`) is unchanged. The EXIF
  block, including any GPS tags in it, is dropped by re-encoding; the app does
  not read EXIF for location.
- A total budget of 3.5 MB of photos per request (assumption: 1 MB under the
  platform limit for framing, values and metadata). Each photo gets an equal
  share for the most photos the form allows (13 at most, so 269 KB each), and
  if a photo is still over its share after the first attempt the encoder steps
  down (1280 px at 0.7, 1024 at 0.6, 800 at 0.5, 640 at 0.45). A photo that
  cannot fit is refused with its name and an instruction to retake it.
  The submit button is held while photos are prepared, and the total is checked
  again before sending.
- A 413 now reads "The photos are too large to send together. Remove one or
  more photos, or take them again, then submit again." The same shrinking, budget
  and message apply to the reply-to-an-evidence-request form.
- Server side: the 8 MB per-file limit stays, and photos that together exceed
  4.5 MB are refused with 413 (`assertPhotoBytes`), which keeps any host that
  is not Vercel consistent.

**Retest.** TC-129 to TC-135 (`app/tests/photo-resize.test.ts`, 14 tests; CI run
45174566208). The canvas path was also run in headless Chromium on a 12-megapixel
JPEG: a 7.6 MB photo became 556 KB at 1600x1200 for a form allowing two photos,
and 133 KB at 1024x768 for one allowing 13 (1.7 MB for all 13), with the modified
time kept (`evidence/hosted/defect-16/`). The hosted retest with a real phone is
recorded in the same folder once it has been run.

## 17. The scoring cron request can outlast the scheduler's timeout, 23 November 2026

**Status: open, not fixed, awaiting the owner's decision.**

**What happened.** cron-job.org reported the scoring job as failed at about
10:43 UTC (13:43 EAT) while the app completed the work: LF-000065's T0 retry
succeeded at 10:43:45 UTC. Evidence: `evidence/hosted/step18/cron-failure.md`.

**Cause.** `/api/cron/scoring` makes up to three calls of up to 15 s for each
due job, so one job holds the request for up to 46.5 s when the scoring
service is slow; here the request lasted about 45 s. cron-job.org probably
waits about 30 s (its documentation as recalled, not verified against its
execution history). The route's own budget is 240 s.

**Effect.** False failure notices; no data lost or duplicated. A real failure
would look the same in the notice.

**Options, none applied.** One attempt per job inside the cron route (the job
queue already retries on the next run); a shorter timeout on the cron path; or
answering the cron request before the work finishes.

## 18. Scoring runner timestamps use the run's start time, 23 November 2026

**Status: open, not fixed, awaiting the owner's decision.**

**What happened.** For LF-000065 the audit event `scoring_failed` (968) is
stamped 10:42:00.260 UTC but happened at about 10:42:48.6, and
`scoring_decision` (969) is stamped 10:43:00.630 but the score finished at
10:43:45.71 (`ScoringDecision.scoredAt`, which is correct). The retry after the
inline failure was due at 10:43:00.26, 12 s later, not the 60 s the setting
intends.

**Cause.** `runScoringJob` takes one `now` (the submission time, or the cron
run's start) and `onFailure`, `onSuccess` and `rescheduleAfterFailure` use it
for audit times and the next due time, although the calls inside took up to
46.5 s.

**Effect.** Audit times are early by the duration of the scoring calls, and
in a long cron batch by the time spent on earlier jobs; the audit chain
records them as written. Retries come sooner than intended. Neither changed a
decision.

**Options, none applied.** Read the clock when each event is written; compute
the retry from that time.
