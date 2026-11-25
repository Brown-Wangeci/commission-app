# Retraining comparison: t7_none

Run 2026-11-25T11:04:47+00:00 by `python -m src.train.retrain`.

## Verdict

**Not enough labels to support any promotion decision.** The export holds 1 usable label(s); `retraining.min_labels_for_promotion` is 500. The numbers below are reported because they were measured, not because they mean anything: a difference computed from this many labels is noise.

**Nothing was promoted.** This run wrote no artifact and changed no configuration. Publishing a model is a separate manual step: see `docs/RETRAINING.md`.

## The labels

- Export `review-labels-20261125T105105Z`, taken 2026-11-25T10:51:05.085Z.
- 1 reviewed submission(s) in the export; 1 scored with the `t7` feature set, which is what this model can learn from.
- By decision: {"approved": 0, "refused": 1}; by mode: {"t7": 1}.
- Decision dates: 2026-10-18T18:50:00.000Z to 2026-10-18T18:50:00.000Z.
- Skipped by the export: {"noFeatureVector": 0, "noDecision": 0}.

## Weighting

Each review row carries weight 1.0 against 1.0 for a synthetic row (`retraining.review_label_weight`). On these folds that is 0.0039% of the training weight. Equal weight is deliberate: review labels exist only for the bands that reach a person, so upweighting them would amplify that selection bias rather than correct it.

## Candidate against baseline

Mean across [7, 42, 101, 2024] (4 seed(s)), out of fold, isotonic-calibrated.

| Metric | Baseline | Candidate | Difference | Baseline sd across seeds |
|---|---|---|---|---|
| pr_auc | 0.7068 | 0.7071 | 0.0003 | 0.0305 |
| recall_at_p90 | 0.4110 | 0.4114 | 0.0004 | 0.0445 |
| recall_at_p95 | 0.3416 | 0.3371 | -0.0045 | 0.0511 |
| review_mean_score | 0.3090 | 0.4919 | 0.1829 | 0.1214 |
| review_pr_auc | n/a | n/a | n/a | n/a |
| roc_auc | 0.9322 | 0.9321 | -0.0001 | 0.0097 |

The spread is across seeds, which is the headline uncertainty. Fold-to-fold variation is secondary and understates it: `StratifiedGroupKFold` orders groups by size, so fold 0 always carries the heaviest agents and the folds are not exchangeable.

`review_pr_auc` and `review_mean_score` are measured on the review labels themselves. For the baseline that is out of sample; **for the candidate it is in sample**, because those rows are in its training split. They are not a basis for choosing between the arms. `n/a` means one class was missing, which it is while there are this few labels.

## The deployed model against the reviewers, on the same submissions

Taken straight from the stored decisions, so no model was refitted here.

| Model band | Reviewer decided | Submissions |
|---|---|---|
| review | refused | 1 |

## Provenance

- generator config hash `e42117cd43ebb0ba7562cf1d7dcdea780fa144b7d8dcb5bcb767a59c160cb251`
- model config hash `7251a370d6d4ad667a8868667184f61d0686f30f3739b802004a5251e0887ae2`
- labels sha256 `58b0c3d0c875bebdec0519cf84c903904a245f00c0f8c6f4fc35d04a1d99f901`
- cv seed 7, seeds [7, 42, 101, 2024], folds per seed all
