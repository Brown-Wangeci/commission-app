# Commission-app: activation-fraud scoring

A capstone ML project: fraud detection for a mobile money agent commission
platform, built entirely on synthetic data (`src/generator/`). Two models
score every activation: `t0_none` at submission, `t7_none` at hold-close
seven days later, once the escrow window has closed. Rules for working on
this code are in `CLAUDE.md`; `docs/model_card.md` documents both deployed
artifacts; `docs/results_index.md` maps every reported number to the file
that holds it.

## Setup

```
python -m venv .venv
.venv\Scripts\activate            # Windows; use .venv/bin/activate on Linux/Mac
pip install -r requirements.txt
```

## Reproducing everything: `scripts/reproduce_all.py`

One entry point runs the full pipeline from a clean checkout: generate the
dataset(s), train, calibrate, evaluate, optimise the decision bands, and
produce every figure and results CSV under `outputs/`. It does nothing a
human could not do by hand, running the same `python -m <module>` commands
in the same order -- it only sequences them, times each one, and checks the
result against what was already on disk.

```
python scripts/reproduce_all.py                    # everything, in order
python scripts/reproduce_all.py --list-stages       # see the stage names
python scripts/reproduce_all.py --dry-run           # print the plan, run nothing
python scripts/reproduce_all.py --stage generate    # just one stage
python scripts/reproduce_all.py --stage train --stage multiseed
python scripts/reproduce_all.py --seed 101          # override the single dataset's seed
python scripts/reproduce_all.py --tolerance 0.05    # widen the reproduction check
```

### Stages, in dependency order

| Stage | What it runs | Depends on |
|---|---|---|
| `generate` | `src.generator.run` -- the single seed-42 dataset used by `train` and the production artifacts | nothing |
| `diagnostics` | `src.eval.report`, `src.eval.seeds`, `src.eval.realisation_control`, `src.eval.lookalike_audit` -- all self-contained, each generates its own in-memory dataset(s) across the four robustness seeds | nothing |
| `train` | `src.train.run` (Phase 3/4 single-seed cross-validated models, and everything `src.eval.results` computes from it), `src.train.resampling_sweep`, `src.eval.collusion_check`, `src.eval.agent_vs_activation`, `src.eval.investigations`, `src.eval.before_after` | `generate`; **the slowest stage by far**, dominated by `resampling_sweep` |
| `multiseed` | `src.train.multiseed` -- the Phase 5 run: three models, four seeds, five folds each, with isotonic and sigmoid calibration | nothing on disk (generates its own datasets); the second-slowest stage |
| `calibrate` | `src.eval.calibration` -- calibration quality and the chosen method | `multiseed` |
| `bands` | `src.eval.costs`, `src.eval.bands`, `src.serve.bands_t0`, `src.eval.fairness`, `src.eval.band_comparison`, `src.eval.auto_release`, `src.eval.multiseed_results`, `src.eval.commission_sweep`, `src.eval.explanations`, `src.eval.disagreement` | `calibrate` |
| `figures` | `src.eval.figures` | most of the above |

A stage's prerequisites must already be on disk before you run it alone
(either from an earlier full run, or an earlier invocation of this script);
the script does not check that for you.

### `--seed`

Overrides `config/generator.yaml`'s top-level `seed` for the duration of the
run, by editing the file, running the requested stages, and restoring the
original content afterwards -- so every stage (each a separate `python -m`
process) reads the same seed, and the manifest each stage writes records
the config hash that actually produced the data on disk. It only affects the
single dataset the `generate`/`train` stages use; `multiseed` always uses
`config/model.yaml`'s `multi_seed.seeds` list.

### How long a full run takes

Measured wall-clock, full run, this machine, this checkout
(`outputs/reproduce_manifest.json` reflects only the most recent
`reproduce_all.py` invocation -- if you run a subset of stages, its
`stage_seconds` only covers those; the table below is the sum of two
invocations that together covered every stage):

| Stage | Seconds | What dominates it |
|---|---|---|
| `generate` | 13 | one dataset, ~90k activations |
| `diagnostics` | 234 (~4 min) | four in-memory dataset generations (`lookalike_audit`, `realisation_control`, `seeds`) |
| `train` | 17,322 (~4h 49min) | dominated by `src.train.resampling_sweep` alone (~3h 49min: 3 methods x 5 ratios x 15 repeat/fold combinations, each a full hyperparameter search); `src.train.run` itself is ~39 min, `agent_vs_activation` ~18 min, the rest under 2 min combined |
| `multiseed` | 1,795 (~30 min) | 3 models x 4 seeds x 5 folds, each with its own hyperparameter search and SHAP sample |
| `calibrate` | 4 | reads `outputs/multiseed_predictions.parquet`, no retraining |
| `bands` | 47 | cost-optimised threshold sweeps, fairness, SHAP aggregation, the T0-vs-T7 disagreement analysis |
| `figures` | 9 | plotting only |
| **total** | **~19,425s (~5h 24min)** | dominated by `train`, specifically `resampling_sweep` |

`resampling_sweep` is the real cost of a full run, not `multiseed` -- it
repeats a similarly-sized hyperparameter search across 3 methods x 5 ratios
instead of `multiseed`'s 3 models, at n_repeats=1 vs `train.run`'s 3 repeats,
so it ends up the single most expensive module in the whole pipeline. If you
only changed a cost-matrix parameter or something else that doesn't touch
model fitting, `--stage bands --stage figures` reruns everything downstream
of the existing calibrated predictions in under a minute. If you only need
the single-seed CV headline results without the resampling comparison, there
is currently no stage finer than `train` to skip just `resampling_sweep` --
run `python -m src.train.run` directly instead.

**Reproducibility, measured, not assumed.** A full rerun on this checkout
reproduced every one of the headline numbers checked by this script (PR-AUC
by model, both models' band operating points, all 48 per-typology recall
rows, and all 9 fairness-by-honesty rows) to 6 significant figures --
identically, not just within tolerance. Two modules were not bit-identical:
`resampling_sweep`'s PR-AUC/recall figures moved at the 5th-6th significant
digit (floating-point noise, not a real difference -- see
`git diff outputs/resampling_sweep_summary.csv` after a rerun for the exact
scale), and `outputs/shap_worked_cases.csv` (`src.eval.explanations`) picked
different example activations than the ones committed -- not because that
module is non-deterministic (rerunning it twice on the same inputs gives an
identical result), but because the previously-committed file had gone stale
relative to the rest of the outputs before this rerun. See
`docs/results_index.md` for the full account of that finding.

### What it produces

Every `outputs/*.csv`, `outputs/*.json` and `outputs/figures/*.png` this
project reports a number from (see `docs/results_index.md` for the full map),
plus `outputs/reproduce_manifest.json`: the stages run, the wall-clock time
per stage and per module, and a comparison of a fixed set of headline
numbers (PR-AUC by model, both models' band operating points, per-typology
recall, the fairness-by-honesty table) against whatever was on disk
immediately before the run. If any of those moved by more than
`--tolerance` (2% relative, by default), the script exits non-zero and
prints exactly which number and by how much -- everything here is
deterministic given the fixed seeds recorded in `config/generator.yaml` and
`config/model.yaml`, so a full rerun should reproduce them up to
floating-point noise from parallel tree building.

Large intermediate files (`data/*.parquet`, `outputs/*.parquet`, model
artifacts) are not committed -- see `.gitignore` -- but every results CSV
and JSON manifest is, since provenance is a deliverable of this project, not
just its code.
