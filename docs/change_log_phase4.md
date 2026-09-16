# Phase 4 change log: generator defect fixes

This file is written in two halves. Everything up to and including section 5 was
written and committed **before any code change**, so the predictions in it cannot
have been adjusted to match the outcome. Section 7 is appended after the rerun
and scores those predictions, including the ones that were wrong.

## 1. The defects

Both defects break the same rule, and both predate any model.

> **Rule (CLAUDE.md, third bullet):** "Every fraud signature must have a
> legitimate counterpart that overlaps it. No feature may separate the classes
> cleanly on its own."

CLAUDE.md is the standing rules file for this repository. It governed Phase 1
(data dictionary and schema) and Phase 2 (generator implementation), and both
defects were introduced by Phase 2 generator code written under it. The file
appears in git only from commit 043eafa (2026-09-15) because the repository held
nothing but an empty initial commit before Phase 3; the rule itself is older than
the code it judges. These are therefore bug fixes against a pre-existing rule,
not tuning against an observed result.

### Defect 1: held payout-gaming jobs have no honest counterpart

`config/generator.yaml` gives payout-gaming activations an acceptance latency of
`lognormal(mu 6.6, sigma 1.05)` minutes (median about 12 hours) for the share of
jobs that are "held", while every legitimate activation draws
`lognormal(mu 2.6, sigma 1.15)` (median about 13 minutes). No lookalike covers
the gap. Realised (`outputs/investigation_acceptance_latency_tail.csv`):

| Acceptance latency | Share of legitimate rows | Share of payout-gaming rows | Fraud share of rows above |
|---|---|---|---|
| > 1 h | 9.64% | 64.6% | 13.1% |
| > 2 h | 2.79% | 60.0% | 25.8% |
| > 3 h | 1.17% | 57.0% | 41.7% |
| > 6 h | 0.20% | 47.8% | 76.1% |
| > 12 h | 0.03% | 31.7% | 93.3% |

Above 12 hours the region is 93% fraud and contains 25 legitimate rows out of
83,287. That is a near-deterministic separator for a third of one typology.

**Fix (B1).** Add an honest counterpart in `legitimate_lookalikes`: agents who
accept jobs as they arrive and work through them later (a second job worked
around, or a multi-day event where a batch is accepted at the start). Share and
distribution chosen on behavioural grounds only.

### Defect 2: careful payout-gaming activations cannot disguise their timing

In `src/generator/activity.py`, `_submission_hours` computes an hour profile that
honours the `careful_blend` mimicry path, and then overwrites it for **every**
payout-gaming row with `cutoff_hour - offset`. A "careful" gaming activation can
disguise its acceptance latency, its downstream behaviour and its binary flags,
but never its time of day. The careful mechanism is the generator's main source
of hard positives, so this silently removes about 30% of gaming rows (the careful
share) from the hard-case population on that dimension.

**Fix (B2).** Apply the override only to gaming rows that are not mimicking on
the timing dimension, exactly as every other typology already works.

## 2. Pre-fix numbers, copied from outputs/

Dataset (`outputs/run_manifest.json`, seed 42): 89,695 activations, realised
fraud rate 0.07144, careful fraud 1,109 rows, ambiguous share 0.1076. Typology
counts: sim farming 2,597, ghost 1,738, payout gaming 1,101, collusion 972.

### 2a. Headline results, mean (sd) across 15 folds

| Model | PR-AUC | ROC-AUC | Recall @90% precision | Recall @95% precision |
|---|---|---|---|---|
| Rules baseline | 0.364 (0.040) | 0.777 (0.017) | 0.086 (0.097) | 0.013 (0.007) |
| Logistic regression, T7 | 0.708 (0.030) | 0.929 (0.011) | 0.366 (0.063) | 0.216 (0.108) |
| XGBoost T7, SMOTE | 0.761 (0.037) | 0.942 (0.015) | 0.502 (0.064) | 0.427 (0.060) |
| XGBoost T7, scale_pos_weight | 0.741 (0.041) | 0.936 (0.019) | 0.458 (0.064) | 0.361 (0.086) |
| XGBoost T0, SMOTE | 0.680 (0.046) | 0.914 (0.024) | 0.399 (0.059) | 0.319 (0.064) |
| XGBoost T0, scale_pos_weight | 0.657 (0.051) | 0.907 (0.028) | 0.337 (0.064) | 0.260 (0.074) |

Test prevalence 0.077 (0.004) in every row.

### 2b. T0-versus-T7 gap (paired, same folds)

| Comparison | PR-AUC difference | sd | Recall @90% difference | Folds favouring T7 |
|---|---|---|---|---|
| SMOTE: T7 minus T0 | +0.0813 | 0.0140 | +0.1030 | 15 of 15 |
| scale_pos_weight: T7 minus T0 | +0.0843 | 0.0140 | +0.1210 | 15 of 15 |

### 2c. Per-typology recall, mean across folds

| Precision target | Typology | XGB T7 SMOTE | XGB T0 SMOTE | LogReg T7 | Rules |
|---|---|---|---|---|---|
| 90% | collusion | 0.077 | 0.033 | 0.056 | 0.003 |
| 90% | ghost | 0.402 | 0.206 | 0.300 | 0.053 |
| 90% | payout gaming | 0.433 | 0.395 | 0.413 | 0.029 |
| 90% | sim farming | 0.787 | 0.695 | 0.518 | 0.177 |
| 95% | collusion | 0.035 | 0.011 | 0.027 | 0.000 |
| 95% | ghost | 0.305 | 0.116 | 0.138 | 0.000 |
| 95% | payout gaming | 0.356 | 0.333 | 0.327 | 0.001 |
| 95% | sim farming | 0.717 | 0.587 | 0.293 | 0.035 |

### 2d. False-positive composition, XGBoost T7 SMOTE

| Precision target | Honest | Opportunistic | Systematic | (share of legitimate test rows) |
|---|---|---|---|---|
| 90% | 0.162 | 0.165 | 0.673 | 0.676 / 0.194 / 0.131 |
| 95% | 0.154 | 0.143 | 0.703 | 0.676 / 0.194 / 0.131 |

### 2e. Other pre-fix numbers

- Rules baseline, `held_job_released_at_cutoff`: fires on 0.29% of rows, precision 0.461, recall 0.017.
- Diagnostics: max single-feature AUC 0.794 (`customer_active_days_7d`); max absolute label correlation 0.315 (`agent_activation_velocity_24h`); cross-validated logistic regression PR-AUC 0.708 (sd 0.030).

## 3. Predictions

Written before the code changes. Each is a point estimate with a range I would
accept as "predicted correctly"; outside the range counts as wrong.

### 3a. Mechanism

1. B1 destroys most of the acceptance-latency signal. The long-latency region stops being fraud-pure, so the fraud share above 12 hours collapses from 93% toward the region of the base rate.
2. Payout gaming loses its strongest handle. It keeps only cutoff-proximity timing and a weak, partly genuine downstream signal.
3. B2 removes the timing tell for the roughly 19% of gaming rows that are careful and mimic on that dimension (30% careful share times about 0.64 mean blend), so its effect is much smaller than B1's.
4. Honest agents who batch-accept now look more like gaming, so some of them become false positives.
5. T0 depends on latency and timing more than T7 does, because T7 keeps the downstream channels. So T0 should lose more than T7, widening the gap.

### 3b. Numbers

| Quantity | Pre-fix | Prediction | Accepted range |
|---|---|---|---|
| Fraud share of rows with latency > 12 h | 0.933 | 0.10 | 0.04 to 0.25 |
| Share of legitimate rows with latency > 12 h | 0.0003 | 0.045 | 0.02 to 0.08 |
| XGB T7 SMOTE PR-AUC | 0.761 | 0.725 | 0.695 to 0.750 |
| XGB T0 SMOTE PR-AUC | 0.680 | 0.640 | 0.605 to 0.665 |
| T7 minus T0 PR-AUC gap (SMOTE) | 0.0813 | 0.090 | 0.075 to 0.110 (widens slightly) |
| Logistic regression T7 PR-AUC | 0.708 | 0.680 | 0.655 to 0.700 |
| Rules baseline PR-AUC | 0.364 | 0.355 | 0.335 to 0.370 |
| XGB T7 SMOTE recall @90% precision | 0.502 | 0.425 | 0.380 to 0.465 |
| Payout gaming recall @90%, T7 SMOTE | 0.433 | 0.250 | 0.150 to 0.320 |
| Payout gaming recall @90%, T0 SMOTE | 0.395 | 0.200 | 0.110 to 0.280 |
| Ghost recall @90%, T7 SMOTE | 0.402 | 0.390 | 0.355 to 0.425 |
| Sim farming recall @90%, T7 SMOTE | 0.787 | 0.775 | 0.735 to 0.810 |
| Collusion recall @90%, T7 SMOTE | 0.077 | 0.075 | 0.045 to 0.110 |
| Honest share of false positives @90% | 0.162 | 0.210 | 0.170 to 0.280 |
| Systematic share of false positives @90% | 0.673 | 0.620 | 0.550 to 0.690 |
| Rule `held_job_released_at_cutoff` precision | 0.461 | 0.150 | 0.060 to 0.280 |

Direction calls, stated separately so they can be scored even if magnitudes miss:

- Overall PR-AUC: **down** for every model.
- T0-versus-T7 gap: **widens**.
- Payout gaming recall: **down sharply**, the largest single move in the table.
- Ghost, sim farming, collusion recall: **roughly unchanged**, moving by less than 0.05. They may drift slightly **down** rather than up, because losing detectable gaming positives from the top of the ranking forces the 90%-precision threshold higher.
- Honest share of false positives: **up**; systematic share: **down**.
- Realised prevalence: **unchanged** within seed noise (0.070 to 0.077).

## 4. Confound: the fix changes the whole dataset, not just latency

Adding draws to the generator shifts every subsequent random number, so the
post-fix dataset is a **different realisation**, not the pre-fix dataset with one
column edited. Different agents get different types, episodes fall on different
days. Any before-and-after difference therefore mixes the fix effect with
realisation noise.

Across seeds 7, 42, 101 and 2024 the realised prevalence already varies from
0.0700 to 0.0762, and per-fold PR-AUC has a standard deviation of about 0.04, so
realisation noise is not negligible at the third decimal place.

**Control, pre-registered here.** A snapshot of the pre-fix `src/` and `config/`
is kept outside the repository. After the fixes, the chosen model
(XGBoost T7, SMOTE) is run on repeat-0 folds for seeds 42, 7 and 101 under both
the pre-fix and post-fix generators. The spread across seeds within each version
estimates realisation noise; the shift between versions at matched seeds
estimates the fix effect. Differences smaller than the seed spread will be
reported as inconclusive rather than as effects.

## 5. What is not being changed

- No modelling parameter, no fold definition, no hyperparameter range, no metric.
- Prevalence stays targeted at 0.070 by the Phase 3 derivation. The episode probabilities are not re-tuned to hold prevalence constant after the fixes; if prevalence drifts, that is reported.
- No parameter is chosen by looking at its effect on a metric.

Sections 6 and 7 are appended after this file is committed: section 6 for the B3
lookalike audit and B4 collusion analysis (each with its own predictions, written
before any fix they imply), section 7 for predictions against outcomes.

## 6. B3 lookalike audit and B4 collusion check (pre-fix data, no fix yet applied)

### 6a. Method

`src/eval/lookalike_audit.py` generalises how defect 1 was found. For every
typology and every observable feature it takes the tail holding 25% of that
typology's rows, on the side where the typology sits relative to legitimate rows,
and measures the share of legitimate rows in the same region. Under 1% is
flagged (the threshold the supervisor set). Binary features use the flag value
the typology prefers instead of a tail.

The audit is marginal, one feature at a time. It would not catch a signature that
is only near-separating in a combination of features. That limitation is
recorded here rather than fixed.

### 6b. Result: two flagged signatures, one root cause

| Typology | Feature | Region | Typology share | Legitimate share | Fraud purity |
|---|---|---|---|---|---|
| payout gaming | `job_acceptance_latency_seconds` | above 15.8 h | 25.1% | **0.011%** | 96.8% |
| payout gaming | `submission_latency_seconds` | above 16.5 h | 25.1% | **0.019%** | 94.5% |

Both are defect 1. `submission_latency_seconds` measures assignment to
submission, so it contains the acceptance delay: the held job leaks into it
arithmetically. The B1 fix changes the acceptance latency of honest rows and so
feeds both features. No separate fix is made for the second flag.

**No other signature is flagged.** The next thinnest counterparts are
`agent_activation_velocity_24h` for sim farming (2.4% of legitimate rows in the
region, 41% fraud purity) and `device_shared_agent_count_30d` for sim farming
(3.8%, 27% purity). Both have named lookalikes (campaign and market day
clustering; honest device-sharing teams) and sit well above the 1% bar.

**Prediction (pre-registered).** After B1, both flags clear: the legitimate share
in each region rises above 1%, and I expect it to land near 4% to 12%, with the
fraud purity of those regions falling from 97% and 95% to below 40%. No new
signature becomes flagged.

### 6c. B4: collusion is genuinely hard, not under-specified

Collusion is compared against the legitimate trial-then-lapse population it is
designed to hide inside. Single-feature AUC is oriented so 0.5 means
indistinguishable; overlap is histogram intersection, where 1.0 means identical.

| Feature | Group | AUC vs trial-lapse | Overlap | Collusion median | Trial-lapse median |
|---|---|---|---|---|---|
| `agent_activation_velocity_24h` | agent history | 0.753 | 0.59 | 6.00 | 2.00 |
| `device_activations_7d` | agent history | 0.730 | 0.65 | 21.0 | 10.0 |
| `days_to_payout_cutoff` | activation | 0.662 | 0.65 | 2.34 | 6.21 |
| `agent_tenure_days` | agent history | 0.649 | 0.72 | 265 | 349 |
| `customer_active_days_7d` | customer | 0.583 | 0.86 | 1.00 | 0.00 |
| `usage_minutes_total_7d` | customer | 0.583 | 0.87 | 0.91 | 0.00 |
| `transaction_count_7d` | customer | 0.575 | 0.88 | 0.00 | 0.00 |
| `days_to_first_customer_activity` | customer | 0.560 | 0.88 | 2.00 | 8.00 |
| `topup_amount_total_7d` | customer | 0.558 | 0.91 | 0.00 | 0.00 |
| `activity_dropoff_flag` | customer | 0.510 | 0.98 | 0.00 | 0.00 |
| `distance_from_agent_home_km` | activation | 0.510 | 0.96 | 2.33 | 2.44 |
| `customer_msisdn_prior_activation_count` | activation | 0.503 | 0.995 | 0.00 | 0.00 |

Every remaining feature sits between 0.503 and 0.552.

**Finding: the design is working as intended.** On the customer channels that
define the typology, collusion and trial-lapse are nearly the same distribution
(AUC 0.51 to 0.58, overlap 0.86 to 0.98). Collusion's low recall is a property
of the problem, not an omission, and is a finding to keep.

Two qualifications, both reported rather than fixed:

1. **What separability exists is situational or agent-level, not collusive.** A
   probe model (agent-grouped 5-fold) separates collusion from trial-lapse at
   ROC-AUC 0.836 using all features, but 0.730 with agent-history features
   removed. The largest activation-level difference is `days_to_payout_cutoff`
   (0.662), which collusion inherits because fraud episodes cluster near payout
   cutoffs for every typology. It is not a collusion signature.
2. **Two signatures collusion could plausibly have, and does not.** A colluding
   customer is usually someone the agent knows, so real collusion might show
   repeat use of the same MSISDN across cycles
   (`customer_msisdn_prior_activation_count`, currently AUC 0.503, no signal at
   all) and shorter distances from the agent's home (currently AUC 0.510).
   **Neither is being added**, because adding a signature after seeing that
   collusion recall is low is exactly the move this procedure exists to prevent.
   They are recorded for your decision.
