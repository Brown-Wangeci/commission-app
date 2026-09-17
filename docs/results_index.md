# Results index

Every number reported in `docs/model_card.md`, the notebooks, or this
project's phase reviews, mapped to the file that holds it and the phase that
produced it. Values below are current as of the full reproduction run
recorded in `outputs/reproduce_manifest.json` (generated
2026-09-17); regenerate with `python scripts/reproduce_all.py` and this file
does not update itself -- if you rerun the pipeline, re-check the numbers
here against the fresh CSVs before trusting this index again.

Large parametrised tables (per-typology recall, per-fold detail, the full
sensitivity sweep) are represented by their headline rows here, with a
pointer to the complete CSV for the rest.

## Dataset summary statistics

| Number | Value | File | Phase |
|---|---|---|---|
| Activations (seed 42, the deployed dataset) | 90,533 | `outputs/run_manifest.json` (`summary.num_activations`) | 2 |
| Agents (honest / opportunistic / systematic) | 273 / 59 / 18 | `outputs/run_manifest.json` (`summary.agent_type_counts`) | 2 |
| Realised fraud rate (seed 42) | 7.350% | `outputs/run_manifest.json` (`summary.realised_fraud_rate`) | 2 |
| Realised fraud rate, mean (sd) across seeds 7/42/101/2024 | 7.19% (0.14pp) computed from 7.01/7.35/7.23/7.16% | `outputs/prevalence_by_seed.csv` | 5 |
| Typology counts (none/sim_farming/ghost/payout_gaming/collusion), seed 42 | 83,879 / 3,047 / 1,396 / 1,151 / 1,060 | `outputs/run_manifest.json` (`summary.typology_counts`) | 2 |
| Ambiguous-case share, seed 42 | 13.73% | `outputs/run_manifest.json` (`summary.ambiguous_share`), `outputs/diagnostics.csv` | 2 |
| T0 / T7 feature counts | 18 / 9 | `outputs/run_manifest.json` (`summary.num_t0_features`/`num_t7_features`) | 2 |
| Mean daily activations, pooled across seeds | 509.0 | `outputs/cost_matrix.csv` (`mean_daily_activations`); `outputs/multiseed_seed_summary.csv` per-seed | 5/6 |

## Diagnostics

| Number | Value | File | Phase |
|---|---|---|---|
| Max single-feature AUC (seed 42) | 0.797 (`customer_active_days_7d`), reference `<= 0.85` | `outputs/single_feature_auc.csv`, `outputs/diagnostics.csv` | 2 |
| Max absolute label correlation (seed 42) | 0.356 (`agent_activation_velocity_24h`), reference `<= 0.90` | `outputs/diagnostics.csv` | 2 |
| Plain logistic regression PR-AUC, cross-validated (seed 42) | 0.703 (sd 0.034 across folds), reference band [0.65, 0.80] | `outputs/diagnostics.csv` | 2 |
| T7 feature correlation matrix (Pearson / Spearman) | up to 0.84 (`customer_active_days_7d` vs `usage_minutes_total_7d`) | `outputs/t7_correlation_pearson.csv`, `outputs/t7_correlation_spearman.csv` | 2 |
| Lookalike audit: signatures flagged at every seed (defects) | 0 of 1 flagged-at-any-seed candidate | `outputs/lookalike_audit_stability.csv` (rule: flagged at every one of `diagnostics.robustness_seeds` to count as a defect) | 4→5 |
| Lookalike audit: the one noise flag | `sim_farming` / `device_shared_agent_count_30d`, flagged at 1 of 4 seeds -- noise, not a defect | `outputs/lookalike_audit_by_seed.csv`, `outputs/lookalike_audit_stability.csv` | 5 |
| Collusion vs. trial-lapse separability (agent-grouped) | activation+customer features only: 0.698 (sd 0.049); all features: 0.818 (sd 0.061) | `outputs/collusion_overlap.csv`, `outputs/collusion_separability_by_fold.csv` | 4 |
| Realisation-control mean PR-AUC (generator-fix vs. random-realisation effect) | prefix mean 0.741 (sd 0.050) across seeds 7/42/101 | `outputs/realisation_control_prefix.csv`, `outputs/realisation_control_postfix.csv` | 4 |
| Prevalence floor (implied minimum fraud rate that keeps every typology represented in every fold) | 0.070 (seed 42); `outputs/prevalence_by_seed.csv` has all four seeds | `outputs/diagnostics.csv` | 2 |

## Full model comparison table (Phase 3/4, single-seed CV, seed 42)

| Model | PR-AUC (sd across folds) | ROC-AUC | Recall@P90 | Recall@P95 | File |
|---|---|---|---|---|---|
| `rules_t7` (4 hand-written rules) | 0.388 (0.032) | 0.797 (0.025) | 0.102 (0.091) | 0.012 (0.013) | `outputs/results_table_formatted.csv`, `outputs/cv_summary.csv` |
| `logreg_t7` | 0.703 (0.034) | 0.931 (0.012) | 0.364 (0.052) | 0.234 (0.066) | same |
| `xgb_t7_smote` | 0.781 (0.035) | 0.948 (0.011) | 0.535 (0.056) | 0.470 (0.059) | same |
| `xgb_t7_spw` (scale_pos_weight) | 0.766 (0.037) | 0.944 (0.012) | 0.514 (0.065) | 0.439 (0.062) | same |
| `xgb_t0_smote` | 0.711 (0.051) | 0.923 (0.020) | 0.453 (0.080) | 0.400 (0.076) | same |
| `xgb_t0_spw` | 0.690 (0.048) | 0.917 (0.019) | 0.419 (0.077) | 0.368 (0.073) | same |

Full model comparison table (Phase 5, multi-seed, mean across seeds
7/42/101/2024 -- this, not the table above, is the one `docs/model_card.md`
cites):

| Model | PR-AUC (sd across seeds) | ROC-AUC | Recall@P90 | Recall@P95 | File |
|---|---|---|---|---|---|
| `t0_none` (deployed T0) | 0.628 (0.042) | 0.898 (0.014) | 0.328 (0.058) | 0.274 (0.056) | `outputs/multiseed_results_summary.csv`, `outputs/multiseed_results_table.csv` |
| `t7_none` (deployed T7, chosen model) | 0.712 (0.034) | 0.930 (0.011) | 0.424 (0.055) | 0.351 (0.060) | same |
| `t7_smote` (pre-registered Phase 3 choice) | 0.703 (0.038) | -- | 0.400 (0.056) | 0.327 (0.069) | same |

Resampling method comparison at matched effective minority ratio (Phase 4,
headline rows; full sweep in `outputs/resampling_sweep_summary.csv`,
per-fold in `outputs/resampling_sweep_by_fold.csv`):

| Method | Ratio | PR-AUC mean (sd) |
|---|---|---|
| none | natural (~0.077) | 0.781 (0.038) |
| smote | 0.1 | 0.780 (0.037) |
| scale_pos_weight | 0.1 | 0.779 (0.037) |
| smotenc | 1.0 | 0.743 (0.041) (worst cell in the sweep) |

## Per-typology recall

Single-seed CV (Phase 3/4) -- full 48-row table (6 models x 2 precision
targets x 4 typologies) in `outputs/typology_recall_summary.csv`,
per-fold detail in `outputs/typology_recall_by_fold.csv`. Headline rows,
`xgb_t7_smote` (the Phase 3 pre-registered choice; the deployed T7 artifact
is `t7_none`, evaluated separately in the multi-seed table above, which has
no per-typology breakdown) at 90% precision:

| Typology | Recall (sd) | n positive (mean, min) |
|---|---|---|
| collusion | 0.123 (n/a) | 115.6, 58 |
| ghost | 0.368 | 142.6, 83 |
| payout_gaming | 0.285 | 113.0, 79 |
| sim_farming | 0.832 | 319.6, 228 |

(sd values and every other model/precision-target combination are in the
full CSV; `collusion` and `payout_gaming` are consistently the hardest
typologies across every model in the table.)

## T0-vs-T7 auto-release comparison (Phase 5)

| Number | Value | File |
|---|---|---|
| T7 auto-released share at 99% release purity | 73.29% | `outputs/auto_release_t0_vs_t7.csv`, `outputs/auto_release_summary.csv` |
| T0 auto-released share at 99% release purity | 57.39% | same |
| T7 fraud-value-released share at 99% purity | 10.18% | same |
| T0 fraud-value-released share at 99% purity | 8.25% | same |
| T7 auto-released share at 95% release purity | 97.50% | same |
| T0 auto-released share at 95% release purity | 97.39% | same |
| Per-seed detail | -- | `outputs/auto_release_by_seed.csv` |

## Both band operating points

| Number | T7 (`t7_none`) | T0 (`t0_none`) | File | Phase |
|---|---|---|---|---|
| Release threshold | 0.266667 | 0.301471 | `outputs/band_operating_point.csv`, `outputs/band_operating_point_t0.csv` | 6 / 8 |
| Reject threshold | 0.666667 | 0.729167 | same | 6 / 8 |
| Auto-released share | 93.72% | 94.98% | same | |
| Review share | 2.96% | 2.51% | same | |
| Reject share | 3.32% | 2.52% | same | |
| Reject precision / recall | 0.910 / 0.413 | 0.919 / 0.316 | same | |
| Released fraud share of all fraud | 39.66% | 51.61% | same | |
| Expected cost per activation (commissions) | 0.1064 | 0.1216 | same | |
| Capacity share used (constraint doesn't bind, either model) | 7.86% of 1 reviewer's capacity | same | same | |

Both are also recorded in the served artifacts'
`artifacts/{t7,t0}_none-isotonic-v1/manifest.json` (`operating_thresholds`)
and cited in `docs/model_card.md`.

## Cost matrix

Every value in `config/costs.yaml`; the computed ones are in
`outputs/cost_matrix.csv` (Phase 6):

| Quantity | Value | Source tag |
|---|---|---|
| `false_negative` | 2.5 commissions | literature (CBK 2025) + assumption |
| `false_positive_review` | 0.05 commissions | assumption |
| `false_positive_reject` | 3.0 commissions | spec (stated value judgement) |
| `review_sensitivity` / `review_specificity` | 0.85 / 0.95 | assumption |
| `commission_value_kes` | 81.34 KSh | assumption (least-sourced input in the file) |
| `review` (computed) | 0.5763 commissions | computed: 9 min / 60 x 312.50 KSh/hr / 81.34 KSh |
| Reviewed-fraud cost (computed) | 0.9513 commissions | computed |
| Reviewed-genuine cost (computed) | 0.7763 commissions | computed |
| `review_capacity_daily_share` (computed) | 0.0786 | computed: 1 reviewer x 40 reviews / 509 activations/day |

## Sensitivity tables (Phase 6, Part D)

Full 17-scenario one-at-a-time sweep in `outputs/band_sensitivity.csv`.
Headline: release threshold moves from 0.267 (baseline) to 0.131
(optimistic: low costs, best reviews) to 0.486 (pessimistic: high costs,
worst reviews); reject threshold moves from 0.667 to 0.836 (pessimistic) or
stays at 0.667 (optimistic, since `false_positive_reject` moved down but the
reject boundary is driven by `false_negative`/`review` in that scenario).
Baseline vs. no-band-structure comparison in `outputs/band_baselines.csv`
(release everything: 0.182 expected cost; review everything: 0.789; reject
everything: 2.782 -- both extremes far worse than the chosen bands' 0.106).
Reviewer staffing sweep (1/2/3 reviewers) in `outputs/band_staffing.csv` --
the capacity constraint does not bind at any of the three levels, so
thresholds are unchanged across all of them.

## Commission-value sweep

| Number | Value | File |
|---|---|---|
| Current assumed commission value | KSh 81.34 | `outputs/commission_collapse_point.csv`, `config/costs.yaml` |
| Review band collapses to zero at or below | KSh 50 | `outputs/commission_collapse_point.csv` |
| Highest value with the review band still empty | KSh 40 | same |
| Full sweep (KSh 50/100/200/350/500) and finer collapse scan | `outputs/commission_sweep.csv`, `outputs/commission_sweep_scan.csv` | |

## Fairness tables (Phase 6)

| Number | Honest | Opportunistic | Systematic | File |
|---|---|---|---|---|
| Auto-released share | 99.14% | 98.51% | 90.85% | `outputs/fairness_bands_by_honesty.csv` |
| Reject share | 0.127% | 0.227% | 1.469% | same |
| Review share | 0.731% | 1.262% | 7.684% | same |
| Systematic-vs-honest reject-rate ratio | -- | -- | ~11.6x | derived from the row above, cited in `docs/model_card.md` limitation 2 |

Fairness by situation (which honest-agent behaviour patterns get held) in
`outputs/fairness_bands_by_situation.csv`; queueing delay in
`outputs/fairness_expected_delay.csv` and `outputs/fairness_queue.csv`
(mean wait for a reviewed activation: 0.0076 days, M/D/1 approximation).
Phase 5-to-6 comparison (correcting the cost model roughly halved the
systematic reject share, 5.71% to 1.47%) in `outputs/comparison_*.csv`.

## SHAP importance breakdown

| Number | Value | File |
|---|---|---|
| Top global feature (mean absolute SHAP) | `customer_active_days_7d`, 0.731 (14.5% of total) | `outputs/shap_global_importance.csv` |
| Second | `agent_tenure_days`, 0.674 (13.4%) | same |
| Agent-history share of the total explanation, all sampled rows | 35.57% | `outputs/shap_agent_history_share.csv` |
| Agent-history share, by fraud typology | collusion 32.9%, ghost 27.9%, payout_gaming 33.2%, sim_farming 29.2% | same |
| Importance by typology (full breakdown) | -- | `outputs/shap_importance_by_typology.csv` |
| Worked examples (one per band, admin-facing reason string) | -- | `outputs/shap_worked_cases.csv` -- **see the conflicting-values note below** |

## Part A: model disagreement numbers (this session)

| Number | Value | File |
|---|---|---|
| Paired test-region rows, both models, 4 seeds | 183,220 | `outputs/disagreement_transition_by_seed.csv` |
| Overall band agreement (same band, both models) | 95.59% | `outputs/disagreement_transition_summary.csv` |
| T0 auto_release -> T7 reject rate | 0.172% (sd 0.030pp); 316 of 183,220 pooled | `outputs/disagreement_release_then_reject_summary.csv`, `_by_seed.csv` |
| ...of which actually fraudulent | 66.64% | same |
| ...commission value at stake, pooled across seeds | KSh 25,011 (136.5 KSh per 1,000 activations scored) | same |
| T0 reject -> T7 auto_release rate | 0.145% (sd 0.060pp); 265 of 183,220 pooled | `outputs/disagreement_reject_then_release_summary.csv`, `_by_seed.csv` |
| ...of which actually genuine (would have cleared) | 73.63% | same |
| Full band-transition matrix | -- | `outputs/disagreement_transition_summary.csv`, `outputs/disagreement_transition_by_seed.csv` |
| Notebook write-up | -- | `notebooks/04_model_disagreement.ipynb` |

## Known stale or conflicting values (C3)

One conflict found, and it is a staleness issue, not a live disagreement
between two current sources:

- **`outputs/shap_worked_cases.csv` was stale before this session's
  reproduction run.** `src.eval.explanations` picks the median-scoring
  activation of each band as its worked example -- deterministic given
  fixed inputs (verified: running it twice in a row on unchanged inputs
  gives byte-identical output). But the version committed to git before this
  session named different activations entirely (`act_0075269`/`act_0045764`/
  `act_0064891`, seeds 2024/7/42) than a fresh run against the current
  `outputs/multiseed_shap.parquet` produces (`act_0087637`/`act_0050289`/
  `act_0063641`, seeds 7/7/101). Every other multiseed-derived output
  (PR-AUC by model, both band operating points, per-typology recall,
  fairness by honesty) reproduced identically across the same rerun, so the
  underlying data and model fits are not the issue -- `shap_worked_cases.csv`
  had simply not been regenerated after some earlier upstream change in this
  project's history. `python scripts/reproduce_all.py` (or just
  `python -m src.eval.explanations`) brings it back in sync; this has now
  been done and committed alongside this session's other changes.
- No other cross-checked number disagreed: the T7/T0 thresholds in
  `docs/model_card.md` match `outputs/band_operating_point{,_t0}.csv` and
  both artifacts' `manifest.json` exactly; the cited PR-AUC (0.712, sd
  0.034) matches `outputs/multiseed_results_summary.csv`'s `t7_none` row;
  the fairness gap (1.469% vs 0.127%, ~11.6x) matches
  `outputs/fairness_bands_by_honesty.csv`; the cost matrix in the model card
  matches `config/costs.yaml` and `outputs/cost_matrix.csv`; the commission
  collapse point (KSh 40/50) matches `outputs/commission_collapse_point.csv`.
- **Reproducibility characteristic, not a conflict**: `outputs/resampling_sweep_summary.csv`
  and `outputs/resampling_sweep_by_fold.csv` are not bit-identical across
  reruns -- values move at the 5th-6th significant digit (e.g. 0.780654 vs
  0.780654, 0.037985 vs 0.0379851), consistent with floating-point summation
  order noise from parallel tree building, not a real difference. Every
  other regenerated file in this project reproduced bit-for-bit identically
  in the same rerun. Worth knowing if a future diff on that specific file
  looks like a change when it is noise.
