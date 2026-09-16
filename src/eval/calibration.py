"""Calibration quality of the chosen model, before and after mapping.

Usage: python -m src.eval.calibration

The decision bands are probability cutoffs, so the scores feeding them have to
mean what they say: among activations scored 0.2, about a fifth should be
fraudulent. This module reports Brier score and expected calibration error for
the raw scores and for each calibration method, and builds the reliability
curves. The method is chosen on calibration quality alone; PR-AUC is reported
only to confirm that calibration has not disturbed the ranking.

Every figure is a mean across seeds, with the seed-level spread beside it.
"""

from __future__ import annotations

from typing import Any, Dict, List

import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, brier_score_loss

from ..generator import config as config_module

OUTPUT_DIR = config_module.REPO_ROOT / "outputs"
PREDICTIONS_PATH = OUTPUT_DIR / "multiseed_predictions.parquet"


def score_columns(model_cfg: Dict[str, Any]) -> List[str]:
    return ["uncalibrated", *[str(m) for m in model_cfg["calibration"]["methods"]]]


def load_predictions(model: str | None = None) -> pd.DataFrame:
    frame = pd.read_parquet(PREDICTIONS_PATH)
    return frame if model is None else frame[frame["model"] == model].reset_index(drop=True)


def expected_calibration_error(
    labels: np.ndarray, probabilities: np.ndarray, bins: int
) -> float:
    """Equal-count binning, so every bin carries the same weight of evidence.

    Equal-width bins would put almost every activation in the first bin, since
    calibrated fraud probabilities pile up near zero.
    """
    order = np.argsort(probabilities)
    grouped = np.array_split(order, bins)
    total = len(labels)
    error = 0.0
    for index in grouped:
        if len(index) == 0:
            continue
        error += len(index) / total * abs(probabilities[index].mean() - labels[index].mean())
    return float(error)


def reliability_curve(
    labels: np.ndarray, probabilities: np.ndarray, bins: int
) -> pd.DataFrame:
    order = np.argsort(probabilities)
    rows = []
    for position, index in enumerate(np.array_split(order, bins)):
        if len(index) == 0:
            continue
        rows.append({
            "bin": position,
            "mean_predicted": float(probabilities[index].mean()),
            "observed_fraud_rate": float(labels[index].mean()),
            "rows": int(len(index)),
        })
    return pd.DataFrame(rows)


def metrics_by_seed(predictions: pd.DataFrame, model_cfg: Dict[str, Any]) -> pd.DataFrame:
    bins = int(model_cfg["calibration"]["ece_bins"])
    rows = []
    for (seed, method), group in _iterate_methods(predictions, model_cfg):
        labels = group["label"].to_numpy()
        probabilities = group["probability"].to_numpy(dtype=float)
        rows.append({
            "seed": seed,
            "method": method,
            "brier": float(brier_score_loss(labels, probabilities)),
            "ece": expected_calibration_error(labels, probabilities, bins),
            "mean_predicted": float(probabilities.mean()),
            "observed_fraud_rate": float(labels.mean()),
            "pr_auc": float(average_precision_score(labels, probabilities)),
        })
    return pd.DataFrame(rows)


def metrics_by_fold(predictions: pd.DataFrame, model_cfg: Dict[str, Any]) -> pd.DataFrame:
    bins = int(model_cfg["calibration"]["ece_bins"])
    rows = []
    for method in score_columns(model_cfg):
        for (seed, fold), group in predictions.groupby(["seed", "fold"]):
            labels = group["label"].to_numpy()
            probabilities = group[method].to_numpy(dtype=float)
            rows.append({
                "seed": seed, "fold": fold, "method": method,
                "brier": float(brier_score_loss(labels, probabilities)),
                "ece": expected_calibration_error(labels, probabilities, bins),
                "pr_auc": float(average_precision_score(labels, probabilities)),
            })
    return pd.DataFrame(rows)


def _iterate_methods(predictions: pd.DataFrame, model_cfg: Dict[str, Any]):
    for method in score_columns(model_cfg):
        for seed, group in predictions.groupby("seed"):
            yield (seed, method), group.assign(probability=group[method])


def summarise(by_seed: pd.DataFrame, by_fold: pd.DataFrame) -> pd.DataFrame:
    """Seed-level mean and spread first; fold-level spread as the secondary figure."""
    seed_stats = by_seed.groupby("method").agg(
        brier_mean=("brier", "mean"), brier_sd_across_seeds=("brier", lambda s: s.std(ddof=1)),
        ece_mean=("ece", "mean"), ece_sd_across_seeds=("ece", lambda s: s.std(ddof=1)),
        pr_auc_mean=("pr_auc", "mean"), pr_auc_sd_across_seeds=("pr_auc", lambda s: s.std(ddof=1)),
        mean_predicted=("mean_predicted", "mean"), observed_fraud_rate=("observed_fraud_rate", "mean"),
    )
    fold_stats = by_fold.groupby("method").agg(
        brier_sd_across_folds=("brier", lambda s: s.std(ddof=1)),
        ece_sd_across_folds=("ece", lambda s: s.std(ddof=1)),
        pr_auc_sd_across_folds=("pr_auc", lambda s: s.std(ddof=1)),
    )
    return seed_stats.join(fold_stats).reset_index()


def curves(predictions: pd.DataFrame, model_cfg: Dict[str, Any]) -> pd.DataFrame:
    bins = int(model_cfg["calibration"]["reliability_bins"])
    frames = []
    for method in score_columns(model_cfg):
        for seed, group in predictions.groupby("seed"):
            curve = reliability_curve(group["label"].to_numpy(), group[method].to_numpy(dtype=float), bins)
            frames.append(curve.assign(method=method, seed=seed))
    return pd.concat(frames, ignore_index=True)


def choose_method(summary: pd.DataFrame, model_cfg: Dict[str, Any]) -> pd.DataFrame:
    """Pick a calibration method on calibration quality alone.

    The rule is fixed before looking at the numbers: lowest expected calibration
    error wins, with Brier score breaking a tie inside one seed-level standard
    deviation. PR-AUC plays no part in the choice; it is carried along only so
    that a change in ranking would be visible.
    """
    candidates = summary[summary["method"] != "uncalibrated"].copy()
    best = candidates.sort_values("ece_mean").iloc[0]
    close = candidates[candidates["ece_mean"] <= best["ece_mean"] + float(best["ece_sd_across_seeds"])]
    chosen = close.sort_values("brier_mean").iloc[0]
    uncalibrated = summary[summary["method"] == "uncalibrated"].iloc[0]
    return pd.DataFrame([{
        "chosen_method": chosen["method"],
        "rule": "lowest ECE; Brier breaks ties within one seed-level sd of the best ECE",
        "ece": chosen["ece_mean"],
        "ece_uncalibrated": uncalibrated["ece_mean"],
        "brier": chosen["brier_mean"],
        "brier_uncalibrated": uncalibrated["brier_mean"],
        "pr_auc": chosen["pr_auc_mean"],
        "pr_auc_uncalibrated": uncalibrated["pr_auc_mean"],
        "pr_auc_change": chosen["pr_auc_mean"] - uncalibrated["pr_auc_mean"],
        "pr_auc_sd_across_seeds": uncalibrated["pr_auc_sd_across_seeds"],
        "pr_auc_sd_across_folds": uncalibrated["pr_auc_sd_across_folds"],
        "pr_auc_change_within_fold_sd": abs(chosen["pr_auc_mean"] - uncalibrated["pr_auc_mean"])
        <= float(uncalibrated["pr_auc_sd_across_folds"]),
        "candidates_considered": ", ".join(candidates["method"]),
    }])


def main() -> None:
    model_cfg = config_module.load_config(config_module.MODEL_CONFIG)
    chosen = str(model_cfg["multi_seed"]["chosen_model"])
    predictions = load_predictions(chosen)

    by_seed = metrics_by_seed(predictions, model_cfg)
    by_fold = metrics_by_fold(predictions, model_cfg)
    summary = summarise(by_seed, by_fold)
    curve_table = curves(predictions, model_cfg)

    choice = choose_method(summary, model_cfg)
    for name, table in {
        "calibration_by_seed": by_seed,
        "calibration_by_fold": by_fold,
        "calibration_summary": summary,
        "calibration_reliability_curves": curve_table,
        "calibration_choice": choice,
    }.items():
        table.to_csv(OUTPUT_DIR / f"{name}.csv", index=False, float_format="%.6g")

    pd.set_option("display.width", 240)
    print(f"chosen model: {chosen}")
    print(summary.round(5).to_string(index=False))
    print()
    print(choice.round(5).to_string(index=False))


if __name__ == "__main__":
    main()
