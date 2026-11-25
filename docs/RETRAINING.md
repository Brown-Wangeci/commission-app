# Retraining with reviewer decisions (DR-10)

How an administrator's decisions become labelled records, how a candidate
model is trained and compared against the one in service, and what has to
happen by hand before anything is deployed.

DR-10: *"Administrator review decisions shall be retained as labelled records
and shall form part of the training data used in subsequent retraining
cycles."*

## 1. The labelled records

Every scoring decision already stores the full feature vector the service
computed, append-only, beside the probability and band it produced
(`ScoringDecision.featureVector`). A reviewer's decision closes a
`ReviewItem` with an action and the id of the decision in force. Together
those are a labelled record: the exact inputs the model saw, and what a
person concluded.

| Field | Meaning |
|---|---|
| `features` | The feature vector the service computed, by name. Never recomputed. |
| `label` | **1** the reviewer refused, **0** the reviewer approved. |
| `decision` | The word itself, so the mapping cannot be read backwards by mistake. |
| `decided_at` | When the reviewer decided. |
| `reviewer_role` | The role that decided, not who. |
| `mode`, `feature_set` | `t0` or `t7`. A submission escalated at T0 was scored on the T0 features alone. |
| `model_probability`, `model_band`, thresholds | What the model said at the time, so model and reviewer can be compared. |
| `agent_group` | An opaque number grouping one agent's rows, so a split can keep them together. |
| `row` | Position in the export. |

**No personal data leaves.** No activation id or reference, no agent,
reviewer or customer identifier, no phone number, device, location or free
text. Rows are built field by field from that list
(`app/src/lib/labels/export.ts`), and `app/tests/label-export.test.ts`
checks the exported bytes against the personal data the database holds for
the same submissions.

Only the **final** human decision counts. A refusal that is contested and
then overturned exports as one row, approved. Asking for evidence and an
agent's own withdrawal are not decisions on the evidence, and export nothing.

## 2. Exporting

Administrators only:

```
GET /api/admin/labels/export      ->  { manifest, rows }
```

Or, writing a versioned folder, from `app/`:

```sh
npx tsx scripts/export-labels.ts
```

It writes `data/review-labels/<version>/`:

| File | Contents |
|---|---|
| `labels.jsonl` | One JSON object per row, fields in a fixed order and features by name, so the bytes are identical on a repeat export. |
| `manifest.json` | Counts by decision, mode, band and open reason, the decision date range, the feature names per mode, what was skipped and why, and the SHA-256 of `labels.jsonl`. |

`data/` is not committed, so an export becomes evidence only when it is
copied somewhere that is.

## 3. Retraining and comparing

```sh
python -m src.train.retrain [--seeds 7,42] [--folds 2] [--export <dir>]
```

Two arms on the same folds, with the same hyperparameters:

| Arm | Trained on |
|---|---|
| `baseline` | The synthetic training split alone: the committed procedure. |
| `candidate` | The same split plus every exported review label, weighted. |

- **Folds.** The agent-grouped, time-ordered folds already used everywhere
  else (`src/eval/cv.py`), one per seed in `retraining.seeds`, each seed with
  its own generated dataset. Review labels join a **training** split and never
  a test split, so neither arm is scored on a row it trained on.
- **Hyperparameters.** Searched once per fold, on the baseline's inner
  validation split, and used by both arms. Searching separately would let
  search noise, rather than the labels, move the comparison.
- **Calibration.** Both arms are calibrated on the same held-out synthetic
  agents, so the two calibrators are comparable.
- **Weighting.** Each review row carries `retraining.review_label_weight`
  against 1.0 for a synthetic row. The default is **1.0**: review labels exist
  only for the bands that reach a person, so upweighting them would amplify
  that selection bias rather than correct it. The report states the share of
  training weight the labels actually carry.
- **Reporting.** Every number is a mean across seeds with the seed-level
  spread. Fold-to-fold variation is reported beside it and understates
  uncertainty, because `StratifiedGroupKFold` orders groups by size, so fold 0
  always carries the heaviest agents and the folds are not exchangeable.

It writes `outputs/retraining_fold_comparison.csv`,
`outputs/retraining_summary.csv` and `outputs/retraining_report.md`.

### Where the parameters live

In **`config/retraining.yaml`**, not in `config/model.yaml`, and the file says
why at length. In short: the committed Phase 5/6 results record the hash of
`config/model.yaml` they were produced from, and `tests/test_config.py` fails
if that hash stops matching the file on disk. Adding a section to `model.yaml`
would break that link for every committed number without any of them
changing. Nothing in `retraining.yaml` feeds the Phase 5/6 evaluation; it is
read only by `src/train/retrain.py`, as `config/serving.yaml` and
`config/costs.yaml` are read only by their own concerns.

### What the comparison cannot tell you

- **Selection bias.** Only the review and escalated bands reach a person, so
  the labels describe the middle and the top of the score range, never the
  auto-released bottom. A model trained on them learns about the cases that
  were already doubtful.
- **The review-label metrics.** Both arms are also scored on the review
  labels. For the baseline that is out of sample; for the candidate it is
  **in sample**, because those rows are in its training split. The report
  says so beside the number, and neither is a basis for choosing an arm.
- **A reviewer is not ground truth.** The label is what a person concluded
  from the evidence, which is the best available signal and is not the same
  thing as whether the activation was fraudulent.
- **Too few labels.** Below `retraining.min_labels_for_promotion` the report
  states plainly that the comparison cannot support a promotion decision. That
  is a floor to stop a handful of rows being read as evidence, not a
  statistical test.

## 4. Promotion is manual

**The pipeline promotes nothing.** It writes no artifact and changes no
configuration; `tests/test_retrain.py` checks that running it leaves
`artifacts/` untouched and that the module reaches nothing in `src/serve`.

To put a retrained model into service, by hand, in this order:

1. **Read the report.** Judge the difference against the seed-level spread,
   not against zero, and check the label count is above
   `retraining.min_labels_for_promotion`.
2. **Decide and write it down.** Record the decision and the reason in
   `docs/model_card.md`, with the report it rests on.
3. **Bump the version** in `config/serving.yaml` (`model_version` or
   `t0_model_version`). A version is never reused.
4. **Build the artifact:** `python -m src.serve.artifact` (add the model name
   for T0). It trains one model on the full dataset with the same procedure
   and writes `artifacts/<version>/`.
5. **Package it:** `python scripts/package_artifacts.py`, which writes the
   reproducible archive and its `.sha256`. Rebuilding on another platform
   gives a numerically different model
   (`docs/chapter5/evidence/hosted/scoring/model-comparison.md`), which is why
   the artifacts are published once and downloaded, not rebuilt.
6. **Publish** the archive as a GitHub release asset, as
   `scoring-artifacts-v1` was, and commit the updated `.sha256` and manifests.
7. **Redeploy the scoring service.** Its build downloads the archive and
   checks the SHA-256 (`render.yaml`); a mismatch fails the build.
8. **Check** `GET /health` reports `"loaded": true` and the new version, and
   that the app's stored decisions carry it.

Steps 3 to 8 are the same ones that published the current artifacts. Nothing
in the retraining pipeline can start them.

## 5. State of this requirement

DR-10 is **partially met**. The records are retained and the export and the
pipeline exist and have been run, but on the labels that exist today: see
`docs/chapter5/evidence/retraining/`. A handful of decisions cannot support a
retraining cycle, and no model has been promoted from them.
