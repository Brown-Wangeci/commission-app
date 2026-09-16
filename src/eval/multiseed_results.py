"""The Phase 5 results table: every model, averaged across seeds.

Usage: python -m src.eval.multiseed_results

The chosen model (no resampling) is reported beside the pre-registered Phase 3
choice (SMOTE at a minority ratio of 0.30), so the deviation from what was
registered is visible rather than buried.

Seed-level spread is the headline uncertainty. Fold-level spread is reported
underneath and understates uncertainty, because StratifiedGroupKFold orders
groups by size and fold 0 always carries the heaviest agents.
"""

from __future__ import annotations

from typing import Any, Dict, List

import pandas as pd

from ..generator import config as config_module
from .calibration import load_predictions
from .metrics import fold_metrics, precision_key

OUTPUT_DIR = config_module.REPO_ROOT / "outputs"


def per_seed(predictions: pd.DataFrame, targets: List[float], score: str) -> pd.DataFrame:
    rows = []
    for (model, seed), group in predictions.groupby(["model", "seed"]):
        rows.append({"model": model, "seed": seed,
                     **fold_metrics(group["label"].to_numpy(), group[score].to_numpy(dtype=float), targets)})
    return pd.DataFrame(rows)


def per_fold(predictions: pd.DataFrame, targets: List[float], score: str) -> pd.DataFrame:
    rows = []
    for (model, seed, fold), group in predictions.groupby(["model", "seed", "fold"]):
        rows.append({"model": model, "seed": seed, "fold": fold,
                     **fold_metrics(group["label"].to_numpy(), group[score].to_numpy(dtype=float), targets)})
    return pd.DataFrame(rows)


def summarise(seeds: pd.DataFrame, folds: pd.DataFrame, targets: List[float]) -> pd.DataFrame:
    columns = ["prevalence", "pr_auc", "roc_auc", *[precision_key(t) for t in targets]]
    seed_stats = seeds.groupby("model")[columns].agg(["mean", "std"])
    seed_stats.columns = [f"{metric}_{'mean' if stat == 'mean' else 'sd_across_seeds'}"
                          for metric, stat in seed_stats.columns]
    fold_stats = folds.groupby("model")[columns].std().add_suffix("_sd_across_folds")
    return seed_stats.join(fold_stats).reset_index()


def formatted(summary: pd.DataFrame, targets: List[float]) -> pd.DataFrame:
    out = summary[["model"]].copy()
    for metric in ["prevalence", "pr_auc", *[precision_key(t) for t in targets]]:
        out[metric] = [
            f"{mean:.3f} ({sd:.3f})"
            for mean, sd in zip(summary[f"{metric}_mean"], summary[f"{metric}_sd_across_seeds"])
        ]
    out["note"] = "mean (sd across the four seeds)"
    return out


def main() -> None:
    model_cfg = config_module.load_config(config_module.MODEL_CONFIG)
    targets = [float(t) for t in model_cfg["reporting"]["precision_targets"]]
    method = str(pd.read_csv(OUTPUT_DIR / "calibration_choice.csv")["chosen_method"].iloc[0])
    predictions = load_predictions()

    seeds = per_seed(predictions, targets, method)
    folds = per_fold(predictions, targets, method)
    summary = summarise(seeds, folds, targets)
    table = formatted(summary, targets)

    for name, frame in {
        "multiseed_results_by_seed": seeds,
        "multiseed_results_by_fold": folds,
        "multiseed_results_summary": summary,
        "multiseed_results_table": table,
    }.items():
        frame.to_csv(OUTPUT_DIR / f"{name}.csv", index=False, float_format="%.6g")

    pd.set_option("display.width", 240)
    print(f"scores: {method} calibrated")
    print(table.to_string(index=False))
    print()
    print(summary[["model", "pr_auc_mean", "pr_auc_sd_across_seeds", "pr_auc_sd_across_folds"]].round(4).to_string(index=False))


if __name__ == "__main__":
    main()
