# DR-10: reviewer decisions as labelled records, and a retraining cycle run on them

One export of the labels a reviewer's decisions leave behind, and one full
comparison of a candidate trained on them against the committed procedure.
Run locally on 25 November 2026. All times are UTC, with EAT (UTC+3) beside
them where they matter.

## Verdict

**The mechanism works end to end; the labels do not yet support a retraining
cycle.** The seeded database holds **one** reviewed submission, so the
candidate differs from the baseline by one row in 25,385. The measured
difference is +0.0003 PR-AUC against a seed-level spread of 0.0305 — about
one per cent of the spread, which is to say nothing at all. **No model was
promoted, and none should be.**

## What was run

| Step | Command | Result |
|---|---|---|
| Export | `npx tsx scripts/export-labels.ts` from `app/` | 1 row, sha256 `58b0c3d0…f901`, written 10:51:05 UTC (13:51:05 EAT) |
| Comparison | `python -m src.train.retrain` | 4 seeds x 5 folds x 2 arms = 40 fits, finished 11:04:47 UTC (14:04:47 EAT) |

Against a local database seeded by `app/prisma/seed.ts`. The seed's people,
numbers and photos are fictional.

## The labels that exist

`export/manifest.json` and `export/labels.jsonl`, committed here in full
because they carry no personal data — which is the point of the export.

| | |
|---|---|
| Reviewed submissions | **1** |
| By decision | 0 approved, 1 refused |
| By mode | 1 `t7` (so 1 usable by the `t7_none` model), 0 `t0` |
| Open reason | `band_review`: the score fell between the cut-offs |
| Agent groups | 1 |
| Features per row | 27, the full T7 set, as the service computed them |
| Skipped | none (`noFeatureVector` 0, `noDecision` 0) |

Why only one. The seed produces 47 paid payouts, but almost all are released
automatically at hold-close and never reach a person. Of the cases a reviewer
does touch, asking for evidence is not a decision on the evidence, an agent's
withdrawal is not a reviewer's decision, and a contested refusal that is still
open has no final decision yet. Exactly one submission in the seed ends in a
reviewer's approve or refuse. That is the real figure and nothing was added to
improve it.

One oddity of seeded data, stated so it is not read as a fault: `decided_at`
(2026-10-18) is earlier than `scored_at` (2026-11-25), because the seed
back-dates the review history while the scoring calls themselves happen when
the seed runs. The pipeline does not order review rows by time, so this
changes nothing here.

## Candidate against baseline

Both arms on the same agent-grouped, time-ordered folds, with the same
hyperparameters, searched once per fold on the baseline's inner split. Review
rows join a training split and never a test split. Full table in `report.md`,
per-fold numbers in `retraining_fold_comparison.csv`.

| Metric | Baseline | Candidate | Difference | Baseline sd across seeds |
|---|---|---|---|---|
| PR-AUC | 0.7068 | 0.7071 | **+0.0003** | 0.0305 |
| ROC-AUC | 0.9322 | 0.9321 | -0.0001 | 0.0097 |
| Recall at 90% precision | 0.4110 | 0.4114 | +0.0004 | 0.0445 |
| Recall at 95% precision | 0.3416 | 0.3371 | -0.0045 | 0.0511 |

Per-seed PR-AUC, baseline then candidate: seed 7 0.6941 / 0.6960, seed 42
0.7518 / 0.7521, seed 101 0.6841 / 0.6847, seed 2024 0.6973 / 0.6956.

The comparison was run twice over, by two separate processes a few minutes
apart, and the two runs produced byte-identical `retraining_fold_comparison.csv`
and `retraining_summary.csv`. That was an accident of how this evidence was
collected rather than a designed check, but it is the determinism the pipeline
claims, measured on the full run rather than on the reduced one in the test
suite.

Every difference is far inside the seed-level spread, which is the headline
uncertainty. Fold-to-fold variation (mean fold sd 0.0498 for PR-AUC)
understates it, because `StratifiedGroupKFold` orders groups by size, so fold
0 always carries the heaviest agents and the folds are not exchangeable.

The one review row carries 0.0039% of the training weight. A difference of
this size is what one row does to where XGBoost puts a split, not evidence
about the labels.

As a consistency check, the baseline's 0.7068 (sd 0.0305) sits inside the
committed `t7_none` figure of 0.712 (sd 0.034) in `../../results_tables.md`,
which came from the separate Phase 5 run. The two procedures differ (this one
searches once per fold and shares the result between arms), so they are not
expected to match exactly.

### The number that moved, and why it means nothing

`review_mean_score` went from 0.3090 to 0.4919: the candidate scores that one
refused submission much higher than the baseline does. That is what training
on a row does to the score it gives that row. It is **in sample** for the
candidate and out of sample for the baseline, and it is not a basis for
choosing between them. `review_pr_auc` is `n/a` throughout, because one row
cannot have two classes.

## The deployed model against the reviewer

Straight from the stored decision, with nothing refitted:

| Model band | Reviewer decided | Submissions |
|---|---|---|
| `review` | refused | 1 |

The model put it between the cut-offs, which is the band that asks for a
person, and the person refused it. One case; it supports no rate of anything.

## Nothing was promoted

The pipeline writes CSVs and a report under `outputs/` and touches neither
`artifacts/` nor `config/serving.yaml`. `tests/test_retrain.py` checks that
running it leaves `artifacts/` byte for byte unchanged and that the module
reaches nothing in `src/serve`. The manual promotion procedure, which
publishes an archive the way `scoring-artifacts-v1` was published, is
`docs/RETRAINING.md` section 4.

`retraining.min_labels_for_promotion` is 500. At 1 label the report refuses to
call the comparison informative, which is why the verdict above is not a
recommendation either way.

## What this does not show

- **Nothing about whether review labels help.** One label cannot show that,
  and this run makes no such claim.
- **Selection bias is untouched.** Labels exist only for the bands that reach
  a person, so they describe the doubtful middle, never the auto-released
  bottom. A larger export would still carry that bias.
- **A reviewer is not ground truth.** The label is what a person concluded
  from the evidence.
- **Local only.** Against a seeded local database, not the hosted one. The
  hosted database holds a similar handful of reviewer decisions.
- **No T0 labels.** The one label was scored at hold-close, so the T0 model
  had nothing to learn from and was not compared.

## Files

| File | Contents |
|---|---|
| `export/labels.jsonl` | The exported labelled record, one JSON object per row |
| `export/manifest.json` | Counts, date range, feature names, skipped counts and the SHA-256 of `labels.jsonl` |
| `report.md` | The comparison report the pipeline wrote, unedited |
| `retraining_summary.csv` | Mean across seeds, seed-level spread and mean fold spread, per arm and metric |
| `retraining_fold_comparison.csv` | All 40 rows: every seed, fold and arm |

## Reproducing

```sh
cd app && npx tsx scripts/export-labels.ts     # against a seeded local database
cd .. && python -m src.train.retrain
```
