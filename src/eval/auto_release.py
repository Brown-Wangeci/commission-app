"""What the escrow hold window actually buys: auto-release volume.

Usage: python -m src.eval.auto_release

PR-AUC averages over every threshold, including regions no escrow system would
ever operate in. Auto-release lives at one end: the platform releases a payout
without a human only where it is nearly certain the activation is genuine. The
right question is therefore how much volume can be released at a given purity,
and the Phase 4 T0-versus-T7 comparison did not measure it.

For each model and seed this finds the largest threshold whose released set is
at least as pure as the target, then reports the released share, the review
queue that remains, and the fraud that slips through, by count and by
commission value.
"""

from __future__ import annotations

from typing import Any, Dict, List

import numpy as np
import pandas as pd

from ..generator import config as config_module
from .calibration import load_predictions

OUTPUT_DIR = config_module.REPO_ROOT / "outputs"


def released_purity_threshold(
    labels: np.ndarray, probabilities: np.ndarray, target_purity: float
) -> float:
    """Largest cutoff whose released set is at least `target_purity` legitimate.

    Released means probability below the cutoff. Sweeping cutoffs upward, purity
    falls monotonically in expectation but not exactly, so this takes the
    largest cutoff that still satisfies the requirement rather than the first
    that fails.
    """
    order = np.argsort(probabilities, kind="stable")
    sorted_labels = labels[order]
    sorted_probabilities = probabilities[order]
    released_counts = np.arange(1, len(labels) + 1)
    frauds_released = np.cumsum(sorted_labels)
    purity = 1.0 - frauds_released / released_counts
    acceptable = np.where(purity >= target_purity)[0]
    if len(acceptable) == 0:
        return 0.0
    return float(sorted_probabilities[acceptable[-1]])


def measure(
    labels: np.ndarray,
    probabilities: np.ndarray,
    commission: np.ndarray,
    target_purity: float,
) -> Dict[str, float]:
    threshold = released_purity_threshold(labels, probabilities, target_purity)
    released = probabilities <= threshold
    fraud_value_total = float(commission[labels == 1].sum())
    released_fraud = released & (labels == 1)
    return {
        "threshold": threshold,
        "auto_released_share": float(released.mean()),
        "released_purity": float(1.0 - labels[released].mean()) if released.any() else np.nan,
        "review_queue_share": float((~released).mean()),
        "fraud_released_count": int(released_fraud.sum()),
        "fraud_released_share_of_all_fraud": float(released_fraud.sum() / max((labels == 1).sum(), 1)),
        "fraud_value_released_commissions": float(commission[released_fraud].sum()),
        "fraud_value_released_share": float(commission[released_fraud].sum() / max(fraud_value_total, 1e-9)),
        "fraud_value_released_per_1000_activations": float(
            commission[released_fraud].sum() / len(labels) * 1000.0
        ),
    }


def table(
    predictions: pd.DataFrame, context: pd.DataFrame, model_cfg: Dict[str, Any], method: str
) -> pd.DataFrame:
    targets = [float(t) for t in model_cfg["auto_release"]["released_precision_targets"]]
    commission_lookup = context.set_index(["seed", "activation_id"])["commission_value"]
    rows: List[Dict[str, Any]] = []
    for (model, seed), group in predictions.groupby(["model", "seed"]):
        commission = commission_lookup.loc[
            list(zip(group["seed"], group["activation_id"]))
        ].to_numpy(dtype=float)
        # Commission value is normalised so that the mean activation is 1.0,
        # keeping "fraud value" in the same units as the cost matrix.
        commission = commission / commission.mean()
        for target in targets:
            rows.append({
                "model": model, "seed": seed, "released_precision_target": target,
                **measure(group["label"].to_numpy(), group[method].to_numpy(dtype=float), commission, target),
            })
    return pd.DataFrame(rows)


def summarise(by_seed: pd.DataFrame) -> pd.DataFrame:
    columns = ["auto_released_share", "review_queue_share", "released_purity",
               "fraud_released_share_of_all_fraud", "fraud_value_released_share",
               "fraud_value_released_per_1000_activations", "threshold"]
    grouped = by_seed.groupby(["model", "released_precision_target"])[columns]
    summary = pd.concat(
        [grouped.mean().add_suffix("_mean"), grouped.std(ddof=1).add_suffix("_sd_across_seeds")], axis=1
    )
    return summary.reset_index()


def comparison(summary: pd.DataFrame, t7: str, t0: str) -> pd.DataFrame:
    """The T7 advantage measured as auto-release volume rather than as PR-AUC."""
    rows = []
    for target, group in summary.groupby("released_precision_target"):
        indexed = group.set_index("model")
        if t7 not in indexed.index or t0 not in indexed.index:
            continue
        t7_share = float(indexed.loc[t7, "auto_released_share_mean"])
        t0_share = float(indexed.loc[t0, "auto_released_share_mean"])
        rows.append({
            "released_precision_target": target,
            "t7_auto_released_share": t7_share,
            "t0_auto_released_share": t0_share,
            "difference": t7_share - t0_share,
            "relative_gain": t7_share / t0_share - 1.0 if t0_share > 0 else np.nan,
            "t7_review_queue_share": float(indexed.loc[t7, "review_queue_share_mean"]),
            "t0_review_queue_share": float(indexed.loc[t0, "review_queue_share_mean"]),
            "t7_fraud_value_released_share": float(indexed.loc[t7, "fraud_value_released_share_mean"]),
            "t0_fraud_value_released_share": float(indexed.loc[t0, "fraud_value_released_share_mean"]),
        })
    return pd.DataFrame(rows)


def main() -> None:
    model_cfg = config_module.load_config(config_module.MODEL_CONFIG)
    method = str(pd.read_csv(OUTPUT_DIR / "calibration_choice.csv")["chosen_method"].iloc[0])
    predictions = load_predictions()
    context = pd.read_parquet(OUTPUT_DIR / "multiseed_row_context.parquet")

    wanted = {str(model_cfg["multi_seed"]["chosen_model"]), str(model_cfg["multi_seed"]["t0_model"])}
    predictions = predictions[predictions["model"].isin(wanted)]

    by_seed = table(predictions, context, model_cfg, method)
    summary = summarise(by_seed)
    against = comparison(summary, str(model_cfg["multi_seed"]["chosen_model"]),
                         str(model_cfg["multi_seed"]["t0_model"]))

    by_seed.to_csv(OUTPUT_DIR / "auto_release_by_seed.csv", index=False, float_format="%.6g")
    summary.to_csv(OUTPUT_DIR / "auto_release_summary.csv", index=False, float_format="%.6g")
    against.to_csv(OUTPUT_DIR / "auto_release_t0_vs_t7.csv", index=False, float_format="%.6g")

    pd.set_option("display.width", 240)
    print(f"calibration method: {method}")
    print(summary.round(4).to_string(index=False))
    print()
    print(against.round(4).to_string(index=False))


if __name__ == "__main__":
    main()
