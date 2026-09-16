"""Where to put the auto-release and reject thresholds, and what it costs.

Usage: python -m src.eval.bands

Three bands: below the release threshold a payout clears automatically, above
the reject threshold it is refused, and in between a human looks at it.

The expected cost per activation under config/costs.yaml is

    P(released and fraudulent) * false_negative
  + P(reviewed and fraudulent) * [review + (1 - sensitivity) * false_negative]
  + P(reviewed and genuine)    * [review + false_positive_review
                                  + (1 - specificity) * false_positive_reject]
  + P(rejected and genuine)    * false_positive_reject

with a correctly released genuine activation and a correctly refused fraudulent
one both costing nothing.

Two corrections from Phase 5, both from the supervisor. The false positive is
split by band, because delaying a genuine activation for nine minutes and
refusing its payout outright are not the same act and pricing them identically
pushed honest work toward the more harmful band. And reviews are no longer
assumed correct: a review that misses fraud pays the false negative, and one
that wrongly refuses honest work pays the rejection cost. A reviewed genuine
activation pays the delay whatever the reviewer decides.

The surface is computed per seed and averaged, so the operating point is the one
that is best across four datasets rather than best on one.
"""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

import numpy as np
import pandas as pd

from ..generator import config as config_module
from .calibration import load_predictions
from .costs import Costs, load_costs, mean_daily_activations_from_summary

OUTPUT_DIR = config_module.REPO_ROOT / "outputs"


def candidate_thresholds(probabilities: np.ndarray, model_cfg: Dict[str, Any]) -> np.ndarray:
    """Quantiles of the calibrated score, because the mass sits near zero."""
    bands_cfg = model_cfg["bands"]
    count = int(bands_cfg["sweep_quantiles"])
    floor = float(bands_cfg["min_band_probability"])
    quantiles = np.quantile(probabilities, np.linspace(0.0, 1.0, count))
    grid = np.unique(np.concatenate([[floor], quantiles, [1.0]]))
    return grid[grid >= floor]


def cost_surface(
    labels: np.ndarray, probabilities: np.ndarray, grid: np.ndarray, costs: Costs
) -> pd.DataFrame:
    """Expected cost per activation at every (release, reject) pair.

    Vectorised over the grid: for each threshold the cumulative counts of frauds
    and genuine rows below it are read off a sorted array, so the whole surface
    costs one sort rather than one pass per pair.
    """
    order = np.argsort(probabilities, kind="stable")
    sorted_probabilities = probabilities[order]
    sorted_labels = labels[order]
    fraud_below = np.concatenate([[0], np.cumsum(sorted_labels)])
    rows_below = np.arange(len(labels) + 1)

    positions = np.searchsorted(sorted_probabilities, grid, side="right")
    frauds_under = fraud_below[positions]
    rows_under = rows_below[positions]
    total = len(labels)
    total_fraud = int(sorted_labels.sum())

    release_index, reject_index = np.meshgrid(
        np.arange(len(grid)), np.arange(len(grid)), indexing="ij"
    )
    valid = grid[release_index] <= grid[reject_index]

    released_rows = rows_under[release_index]
    released_fraud = frauds_under[release_index]
    reject_rows = total - rows_under[reject_index]
    reject_fraud = total_fraud - frauds_under[reject_index]
    review_rows = rows_under[reject_index] - released_rows
    review_fraud = frauds_under[reject_index] - released_fraud

    cost = (
        released_fraud * costs.false_negative
        + review_fraud * costs.reviewed_fraud_cost()
        + (review_rows - review_fraud) * costs.reviewed_genuine_cost()
        + (reject_rows - reject_fraud) * costs.false_positive_reject
    ) / total

    frame = pd.DataFrame({
        "release_threshold": grid[release_index][valid],
        "reject_threshold": grid[reject_index][valid],
        "expected_cost": cost[valid],
        "released_share": (released_rows / total)[valid],
        "review_share": (review_rows / total)[valid],
        "reject_share": (reject_rows / total)[valid],
        "released_fraud_share_of_all_fraud": (released_fraud / max(total_fraud, 1))[valid],
        "reject_precision": np.divide(
            reject_fraud, reject_rows, out=np.zeros_like(cost), where=reject_rows > 0
        )[valid],
        "reject_recall": (reject_fraud / max(total_fraud, 1))[valid],
    })
    return frame


def mean_surface(
    predictions: pd.DataFrame, method: str, model_cfg: Dict[str, Any], costs: Costs
) -> pd.DataFrame:
    """One surface per seed on a shared grid, then averaged across seeds."""
    grid = candidate_thresholds(predictions[method].to_numpy(dtype=float), model_cfg)
    frames = []
    for seed, group in predictions.groupby("seed"):
        surface = cost_surface(
            group["label"].to_numpy(), group[method].to_numpy(dtype=float), grid, costs
        )
        frames.append(surface.assign(seed=seed))
    stacked = pd.concat(frames, ignore_index=True)
    columns = [c for c in stacked.columns if c not in {"seed", "release_threshold", "reject_threshold"}]
    grouped = stacked.groupby(["release_threshold", "reject_threshold"])
    averaged = grouped[columns].mean()
    averaged["expected_cost_sd_across_seeds"] = grouped["expected_cost"].std(ddof=1)
    return averaged.reset_index()


def optimum(surface: pd.DataFrame, capacity: float | None) -> pd.Series:
    feasible = surface if capacity is None else surface[surface["review_share"] <= capacity]
    if feasible.empty:
        return surface.iloc[surface["expected_cost"].argmin()]
    return feasible.iloc[feasible["expected_cost"].argmin()]


def baselines(labels: np.ndarray, costs: Costs) -> pd.DataFrame:
    prevalence = float(labels.mean())
    return pd.DataFrame([
        {"policy": "release everything", "expected_cost": prevalence * costs.false_negative,
         "review_share": 0.0},
        {"policy": "review everything",
         "expected_cost": prevalence * costs.reviewed_fraud_cost()
         + (1 - prevalence) * costs.reviewed_genuine_cost(),
         "review_share": 1.0},
        {"policy": "reject everything", "expected_cost": (1 - prevalence) * costs.false_positive_reject,
         "review_share": 0.0},
    ])


def sensitivity(
    predictions: pd.DataFrame, method: str, model_cfg: Dict[str, Any], daily: float
) -> pd.DataFrame:
    """Re-optimise at each end of every cost range, one at a time and together."""
    base = load_costs(daily)
    raw = base.raw
    scenarios: List[Tuple[str, Dict[str, float], int]] = [("baseline", {}, base.reviewers)]
    ranges = {
        "false_negative": raw["false_negative_range"],
        "false_positive_review": raw["false_positive_review_range"],
        "false_positive_reject": raw["false_positive_reject_range"],
        "review": raw["review_range"],
        "review_sensitivity": raw["review_sensitivity_range"],
        "review_specificity": raw["review_specificity_range"],
    }
    for name, (low, high) in ranges.items():
        scenarios.append((f"{name} low ({low})", {name: float(low)}, base.reviewers))
        scenarios.append((f"{name} high ({high})", {name: float(high)}, base.reviewers))
    capacity_low, capacity_high = raw["review_capacity_range"]
    scenarios.append((f"capacity low ({capacity_low})", {"review_capacity_daily_share": float(capacity_low)}, base.reviewers))
    scenarios.append((f"capacity high ({capacity_high})", {"review_capacity_daily_share": float(capacity_high)}, base.reviewers))
    # All-low and all-high are read as best case and worst case, not as
    # "every number at its lower bound": for the two accuracy parameters the
    # optimistic end is the HIGH one, because a better review is cheaper.
    accuracy = {"review_sensitivity", "review_specificity"}
    optimistic = {
        name: float(bounds[1] if name in accuracy else bounds[0]) for name, bounds in ranges.items()
    }
    pessimistic = {
        name: float(bounds[0] if name in accuracy else bounds[1]) for name, bounds in ranges.items()
    }
    scenarios.append(("all-low costs, best reviews (optimistic)", optimistic, base.reviewers))
    scenarios.append(("all-high costs, worst reviews (pessimistic)", pessimistic, base.reviewers))

    rows = []
    for label, overrides, reviewers in scenarios:
        costs = load_costs(daily, reviewers=reviewers, overrides=dict(overrides))
        surface = mean_surface(predictions, method, model_cfg, costs)
        point = optimum(surface, costs.review_capacity_daily_share)
        rows.append({
            "scenario": label,
            "false_negative": costs.false_negative,
            "false_positive_review": costs.false_positive_review,
            "false_positive_reject": costs.false_positive_reject,
            "review": costs.review,
            "review_sensitivity": costs.review_sensitivity,
            "review_specificity": costs.review_specificity,
            "capacity": costs.review_capacity_daily_share,
            "release_threshold": point["release_threshold"], "reject_threshold": point["reject_threshold"],
            "expected_cost": point["expected_cost"], "review_share": point["review_share"],
            "reject_share": point["reject_share"], "released_share": point["released_share"],
        })
    table = pd.DataFrame(rows)
    baseline_row = table.iloc[0]
    table["release_shift"] = table["release_threshold"] - baseline_row["release_threshold"]
    table["reject_shift"] = table["reject_threshold"] - baseline_row["reject_threshold"]
    return table


def staffing(
    predictions: pd.DataFrame, method: str, model_cfg: Dict[str, Any], daily: float
) -> pd.DataFrame:
    rows = []
    for reviewers in [int(r) for r in load_costs(daily).raw["reviewers_sweep"]]:
        costs = load_costs(daily, reviewers=reviewers)
        surface = mean_surface(predictions, method, model_cfg, costs)
        constrained = optimum(surface, costs.review_capacity_daily_share)
        rows.append({
            "reviewers": reviewers,
            "capacity_share": costs.review_capacity_daily_share,
            "release_threshold": constrained["release_threshold"],
            "reject_threshold": constrained["reject_threshold"],
            "expected_cost": constrained["expected_cost"],
            "review_share": constrained["review_share"],
            "reject_share": constrained["reject_share"],
            "released_share": constrained["released_share"],
            "reject_precision": constrained["reject_precision"],
            "reject_recall": constrained["reject_recall"],
        })
    return pd.DataFrame(rows)


def operating_point_row(point: pd.Series, costs: Costs, label: str) -> Dict[str, Any]:
    return {
        "variant": label,
        "release_threshold": float(point["release_threshold"]),
        "reject_threshold": float(point["reject_threshold"]),
        "expected_cost_per_activation": float(point["expected_cost"]),
        "expected_cost_sd_across_seeds": float(point.get("expected_cost_sd_across_seeds", np.nan)),
        "released_share": float(point["released_share"]),
        "review_share": float(point["review_share"]),
        "reject_share": float(point["reject_share"]),
        "reject_precision": float(point["reject_precision"]),
        "reject_recall": float(point["reject_recall"]),
        "released_fraud_share_of_all_fraud": float(point["released_fraud_share_of_all_fraud"]),
        "capacity_share": costs.review_capacity_daily_share,
        "reviewers": costs.reviewers,
    }


def main() -> None:
    model_cfg = config_module.load_config(config_module.MODEL_CONFIG)
    method = str(pd.read_csv(OUTPUT_DIR / "calibration_choice.csv")["chosen_method"].iloc[0])
    chosen = str(model_cfg["multi_seed"]["chosen_model"])
    predictions = load_predictions(chosen)
    daily = mean_daily_activations_from_summary()
    costs = load_costs(daily)

    surface = mean_surface(predictions, method, model_cfg, costs)
    unconstrained = optimum(surface, None)
    constrained = optimum(surface, costs.review_capacity_daily_share)
    points = pd.DataFrame([
        operating_point_row(constrained, costs, "chosen (capacity constrained)"),
        operating_point_row(unconstrained, costs, "unconstrained"),
    ])
    points["constraint_cost"] = points["expected_cost_per_activation"] - float(unconstrained["expected_cost"])

    surface.to_csv(OUTPUT_DIR / "band_cost_surface.csv", index=False, float_format="%.6g")
    points.to_csv(OUTPUT_DIR / "band_operating_point.csv", index=False, float_format="%.6g")
    baselines(predictions["label"].to_numpy(), costs).to_csv(
        OUTPUT_DIR / "band_baselines.csv", index=False, float_format="%.6g"
    )
    sensitivity(predictions, method, model_cfg, daily).to_csv(
        OUTPUT_DIR / "band_sensitivity.csv", index=False, float_format="%.6g"
    )
    staffing(predictions, method, model_cfg, daily).to_csv(
        OUTPUT_DIR / "band_staffing.csv", index=False, float_format="%.6g"
    )

    pd.set_option("display.width", 240)
    print(points.round(5).to_string(index=False))


if __name__ == "__main__":
    main()
