# Model card: activation-fraud scoring model

Two artifacts are served, one per decision point in the escrow design:
**`t7_none-isotonic-v1`** decides at hold-close (seven days after
submission, once the downstream activity log exists) and
**`t0_none-isotonic-v1`** decides at submission (before any downstream
activity exists). Both are built by `python -m src.serve.artifact <name>
<version>`. This card documents both; the numbers below are read off
`artifacts/t7_none-isotonic-v1/manifest.json`,
`artifacts/t0_none-isotonic-v1/manifest.json`, and the Phase 5/6 evaluation
outputs they cite. Unless a section says otherwise, it describes the T7
artifact, which is the one that makes the final release/reject decision.
Regenerating an artifact overwrites its `manifest.json` with fresh
provenance; the version string is bumped by hand in `config/serving.yaml`
before that is done deliberately.

## Model type

XGBoost binary classifier (gradient-boosted trees), isotonic-regression
calibrated. No resampling and no class weighting (`method: "none"`) --
Phase 4's matched-strength sweep found every imbalance-handling method
within 0.004 PR-AUC of every other against a fold standard deviation of
0.037, with no handling scoring highest.

- Hyperparameters (chosen by a 12-candidate random search on an
  agent-grouped inner validation split): `n_estimators=700`, `max_depth=3`,
  `learning_rate=0.0562`, `min_child_weight=10`, `subsample=0.918`,
  `colsample_bytree=0.864`, `reg_lambda=2.92`.
- Calibration method: isotonic regression, chosen over Platt scaling on
  calibration quality alone (Phase 5 Part B): expected calibration error
  0.0067 against 0.0212 for Platt and 0.0105 uncalibrated.
- **Calibrated probabilities are clipped to `[0.001, 0.999]`**
  (`config/serving.yaml` `probability_clip_low` / `probability_clip_high`,
  source: spec). Isotonic regression saturates at exactly 0.000 or 1.000 for
  scores past the outermost calibration bin, and a system that refuses a
  payout cannot claim absolute certainty. The clip is applied once, inside
  `LoadedArtifact.calibrate`, which is the single method both the serving
  path and any offline comparison call -- so a probability is clipped
  identically wherever it is produced, and no separate offline/served
  clipping logic can drift apart. Both operating thresholds sit strictly
  inside `[0.001, 0.999]` for both artifacts, so clipping changes no band
  assignment; `tests/test_serve.py` asserts this directly by comparing the
  band each of the twenty smoke-test activations receives from the clipped
  and unclipped calibrator.

## Feature set

T7: the 18 T0 features (available the moment an activation is submitted)
plus the 9 T7 features (available seven days later, once the escrow hold
window has closed). Full list and formulas: `docs/data_dictionary.md`
sections 3-4. **This model can only be scored after the 7-day downstream
activity window has closed** -- it is not a point-of-submission model; that
role is `t0_none` in the same evaluation, not deployed here.

Six of the twenty-seven features describe the agent's recent history rather
than this specific activation or its customer (`agent_tenure_days`,
`agent_activation_velocity_1h`, `agent_activation_velocity_24h`,
`device_activations_7d`, `device_shared_agent_count_30d`,
`distinct_devices_used_30d`; see `src/train/data.py::AGENT_HISTORY_FEATURES`).
The service marks a reason as agent-level whenever it comes from one of
these.

## Training data provenance

- **Synthetic.** Every field is produced by `src/generator/` from
  distributional assumptions in `config/generator.yaml`; none of it is an
  empirical claim about real agents, customers or fraud rates. See
  `docs/data_dictionary.md` section 1 for the label definition and section 6
  for how the four fraud typologies are generated.
- Generator config hash: `e42117cd43ebb0ba7562cf1d7dcdea780fa144b7d8dcb5bcb767a59c160cb251`
- Model config hash: `7251a370d6d4ad667a8868667184f61d0686f30f3739b802004a5251e0887ae2`
- Generation seed: `42`
- 90,533 activations, realised fraud rate 7.35%.
- Fit on 67,909 rows (agents not held out for calibration); the isotonic
  calibrator is fitted on the remaining 22,624 rows, held out by whole
  agent so the model never saw them during tree fitting.

This is a **different** exercise from the Phase 5/6 evaluation, which
trained and scored across four seeds (7, 42, 101, 2024) using repeated
grouped cross-validation with a held-out test period, specifically to
measure out-of-fold performance honestly. This artifact is the single
deployable model: it is fit on the full dataset on disk (seed 42) using the
same agent-grouped fit/calibration procedure but with no outer test fold,
since a deployed model has no evaluation set of its own to hold back --
Phase 5/6 already produced the performance numbers below, and training this
artifact changes no parameter that would invalidate them.

## Cross-validated performance (Phase 5/6, not measured on this artifact)

**This artifact -- both the T7 model above and the T0 model below -- is
trained on a single generated dataset at seed 42, and has no held-out
evaluation set of its own.** The table below is not a measurement of this
artifact; it is the mean (sd) out-of-fold performance across four
independently generated datasets (seeds 7, 42, 101, 2024) under repeated
grouped cross-validation, reported here as provenance for the modelling
choices (feature set, imbalance method, hyperparameters) that this artifact
reuses unchanged. Seed 42's own fold in that run is not this artifact
either -- this artifact is fit on the full seed-42 dataset with no fold held
back, since a deployed model has nothing of its own to score out-of-fold
against.

Mean (sd across seeds 7, 42, 101, 2024), repeated grouped cross-validation,
same feature set and imbalance method:

| Metric | Value |
|---|---|
| Prevalence | 0.073 (0.003) |
| PR-AUC | 0.712 (0.034) |
| ROC-AUC | 0.930 (0.011) |
| Recall at 90% precision | 0.424 (0.055) |
| Recall at 95% precision | 0.351 (0.060) |

The pre-registered Phase 3 choice (SMOTE, minority ratio 0.30) scored 0.703
(0.038) PR-AUC on the same folds -- within the seed-level spread of the
model actually deployed here.

## Chosen operating thresholds (T7 model)

From the Phase 6 cost-optimised bands (`outputs/band_operating_point.csv`,
row "chosen (capacity constrained)"; the capacity constraint does not bind at
this cost matrix):

| Threshold | Calibrated probability |
|---|---|
| Auto-release (at or below) | 0.266667 |
| Reject (strictly above) | 0.666667 |

At these thresholds: 93.7% of activations auto-release, 3.0% go to review,
3.3% are refused; the refuse band's precision is 0.910 and recall 0.413;
39.7% of all fraud is auto-released. Expected cost 0.106 commissions per
activation, against 0.182 for releasing everything untouched.

## Cost matrix used to derive the thresholds

All costs in units of one agent commission (`config/costs.yaml`):

| Quantity | Value | Source |
|---|---|---|
| `false_negative` (auto-release a fraud) | 2.5 | literature (CBK 2025) for the unrecoverable share; the multiple is an assumption |
| `false_positive_review` (delay a genuine activation) | 0.05 | assumption, anchored to the Phase 5 measured mean review wait |
| `false_positive_reject` (refuse a genuine activation) | 3.0 | **stated value judgement**, not measured: set above `false_negative` deliberately |
| `review_sensitivity` (P a review catches fraud) | 0.85 | assumption |
| `review_specificity` (P a review clears honest work) | 0.95 | assumption |
| `review` (cost of one review) | 0.576 | computed: 9 min / 60 x KSh 312.50/hour / KSh 81.34 per commission |
| Reviewed-fraud cost | 0.951 | computed: review + (1 - sensitivity) x false_negative |
| Reviewed-genuine cost | 0.776 | computed: review + delay + (1 - specificity) x false_positive_reject |

## T0 model

Artifact version **`t0_none-isotonic-v1`**. Same training procedure as the
T7 model above (XGBoost, agent-grouped fit/calibration split, isotonic
calibration, seed 42, no resampling), but fit on the 18 T0 features only --
whatever is known **at submission**, before any downstream activity exists.
It is the first of the two decision points in the escrow design; the T7
model above is the second, deciding at hold-close once the seven-day
downstream log exists. A released activation is paid out before the T7
model ever sees the case, so the T0 decision, not the T7 decision, is the
one that actually controls payout for anything it releases.

### Chosen operating thresholds (T0 model)

From the same Phase 6 cost-optimisation procedure, run against the T0
model's own predictions under the **same, unchanged** cost matrix above
(`outputs/band_operating_point_t0.csv`; the capacity constraint does not
bind here either):

| Threshold | Calibrated probability |
|---|---|
| Auto-release (at or below) | 0.301471 |
| Reject (strictly above) | 0.729167 |

At these thresholds: 94.98% of activations auto-release at submission,
2.51% go to review, 2.52% are refused; the refuse band's precision is
0.919 and recall 0.316; 51.61% of all fraud is auto-released at this
decision point (recoverable, in principle, if the same case is later
rejected at hold-close -- see Limitations).

### Phase 5 auto-release comparison (T0 vs T7, at fixed release purity)

From `outputs/auto_release_t0_vs_t7.csv`, at a 99% released-precision
target:

| Model | Auto-released share | Review queue share | Fraud value released share |
|---|---|---|---|
| T7 (hold-close) | 73.29% | 26.71% | 10.18% |
| T0 (submission) | 57.39% | 42.61% | 8.25% |

At the same release-purity target, the T0 model releases a smaller share of
activations and sends more to review than the T7 model does, because it
must decide without the seven-day downstream signal. This table uses a
fixed-purity operating point for direct comparison; it is not the cost-
optimised operating point either model is actually served at (that is the
"Chosen operating thresholds" table for each model above).

## Limitations

1. **The three-band design depends on an unsourced number.** `review` is
   computed as `review_minutes x loaded_hourly_rate / commission_value_kes`,
   and `commission_value_kes` (KSh 81.34) comes from the generator's assumed
   escrow distribution, not from an industry partner or a measurement. Phase
   6's sweep found the review band empty at or below KSh 40 and open from
   KSh 50 upward -- the assumed value sits less than twice that collapse
   point. If the real commission value is materially lower, review becomes
   uneconomic and the rational design is two bands (release or refuse), not
   three. This is the single number to obtain before relying on this
   artifact's bands in a real deployment.

2. **Fairness disparity by agent type.** At the chosen operating point, a
   systematic agent's genuine activation is refused 1.469% of the time,
   against 0.127% for an honest agent's -- about an 11.6x gap
   (`outputs/fairness_bands_by_honesty.csv`). Correcting the cost model in
   Phase 6 cut outright refusal for every agent type by about three
   quarters, but did not close this gap: it lowered the whole curve without
   flattening it. Within honest agents specifically, the cost of a false
   positive falls disproportionately on agents whose legitimate working
   patterns resemble fraud (shared team devices, batch job acceptance);
   honest work with no such pattern is refused at a much lower rate. This
   model does not correct for that; it is reported so a deployment decision
   can account for it.

3. **Trained and evaluated entirely on synthetic data.** No real activation,
   agent or fraud case has been used anywhere in this project. Every
   generator assumption carries a source tag in `config/generator.yaml`
   (`spec`, `literature`, `industry partner`, `assumption`); almost all of
   them are `assumption`. This model has not been validated against a real
   population, and the realised fraud rate, typology mix and every
   behavioural distribution are calibrated for a defensible learning
   problem, not fitted to observed fraud.

4. **Trailing-window features are only as accurate as the history supplied
   at scoring time.** `agent_activation_velocity_1h/24h`,
   `device_activations_7d`, `device_shared_agent_count_30d`,
   `distinct_devices_used_30d` and `customer_msisdn_prior_activation_count`
   are computed by `src/generator/features.py::build_features` from whatever
   `recent_activations` the caller supplies. If that history omits relevant
   activity (a different window of history than the feature actually needs),
   the computed feature understates the true count; the service does not
   independently verify completeness.

5. **No calibration or decision-band recalibration has been done this
   session.** The artifact's thresholds are copied from
   `outputs/band_operating_point.csv` as produced by Phase 6 and are not
   recomputed by `src/serve/artifact.py`.

6. **The T0 and T7 models can disagree, and a T0 release is a payout
   already made.** They are different models, trained on different feature
   sets, scored at different times, with independently chosen thresholds --
   nothing forces their band assignments to agree on the same activation. A
   twenty-record smoke test (`scripts/smoke_test_service.py`) found 5 of 20
   held-out activations assigned to a different band by the two models. The
   case that matters operationally is a T0 auto-release followed by a T7
   reject on the same activation: by the time the T7 model runs, at
   hold-close, the escrow has already been released against the T0
   decision, so a later T7 reject identifies a fraud that has already been
   paid, not one that can still be stopped by refusing it. None of the
   twenty smoke-test activations hit this case, but the service does not
   prevent it, and `/explain/{activation_id}` returns both records, in time
   order, specifically so a dispute review can see a decision revised this
   way.
