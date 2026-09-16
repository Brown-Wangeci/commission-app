"""Does the three-band design survive the one number nobody has measured?

Usage: python -m src.eval.commission_sweep

The review cost is `review_minutes * loaded_hourly_rate / commission_value_kes`,
so every band boundary scales inversely with the shilling value of a commission.
That value is currently an unsourced generator assumption of KSh 81.34: it comes
from an assumed escrow distribution, not from an industry partner.

This re-optimises the bands at a range of commission values and finds where the
middle band stops existing, which is the point at which the design collapses
from three bands to two.
"""

from __future__ import annotations

from typing import Any, Dict, List

import numpy as np
import pandas as pd

from ..generator import config as config_module
from .bands import mean_surface, optimum
from .calibration import load_predictions
from .costs import load_costs, mean_daily_activations_from_summary

OUTPUT_DIR = config_module.REPO_ROOT / "outputs"


def optimise_at(
    predictions: pd.DataFrame, method: str, model_cfg: Dict[str, Any], daily: float, commission_value: float
) -> Dict[str, Any]:
    costs = load_costs(daily, overrides={"commission_value_kes": commission_value})
    surface = mean_surface(predictions, method, model_cfg, costs)
    point = optimum(surface, costs.review_capacity_daily_share)
    return {
        "commission_value_kes": commission_value,
        "review_cost_commissions": costs.review,
        "reviewed_genuine_cost": costs.reviewed_genuine_cost(),
        "reviewed_fraud_cost": costs.reviewed_fraud_cost(),
        "release_threshold": float(point["release_threshold"]),
        "reject_threshold": float(point["reject_threshold"]),
        "released_share": float(point["released_share"]),
        "review_share": float(point["review_share"]),
        "reject_share": float(point["reject_share"]),
        "expected_cost": float(point["expected_cost"]),
        "reject_precision": float(point["reject_precision"]),
        "reject_recall": float(point["reject_recall"]),
        "released_fraud_share_of_all_fraud": float(point["released_fraud_share_of_all_fraud"]),
    }


def collapse_point(scan: pd.DataFrame, threshold_share: float) -> Dict[str, Any]:
    """The commission value below which the middle band is gone.

    Scanning upward, the review band opens once reviews are cheap enough to be
    worth buying. The reported figure is the lowest scanned commission value at
    which the band is open and stays open above it.
    """
    ordered = scan.sort_values("commission_value_kes").reset_index(drop=True)
    open_band = ordered["review_share"] > threshold_share
    if not open_band.any():
        return {"collapses_below_kes": np.nan, "note": "the review band is empty at every scanned value"}
    if open_band.all():
        return {"collapses_below_kes": np.nan, "note": "the review band is open at every scanned value"}
    # Walk down from the top: the first closed band going down marks the edge.
    last_closed = ordered.loc[~open_band, "commission_value_kes"].max()
    first_open_above = ordered.loc[
        open_band & (ordered["commission_value_kes"] > last_closed), "commission_value_kes"
    ].min()
    return {
        "collapses_below_kes": float(first_open_above),
        "highest_value_with_no_review_band_kes": float(last_closed),
        "note": "the middle band is empty at or below the second figure and open above it",
    }


def main() -> None:
    model_cfg = config_module.load_config(config_module.MODEL_CONFIG)
    method = str(pd.read_csv(OUTPUT_DIR / "calibration_choice.csv")["chosen_method"].iloc[0])
    predictions = load_predictions(str(model_cfg["multi_seed"]["chosen_model"]))
    daily = mean_daily_activations_from_summary()
    raw = load_costs(daily).raw

    headline = pd.DataFrame([
        optimise_at(predictions, method, model_cfg, daily, float(value))
        for value in raw["commission_value_sweep_kes"]
    ])
    scan_cfg = raw["commission_collapse_scan_kes"]
    scan_values = np.linspace(float(scan_cfg["low"]), float(scan_cfg["high"]), int(scan_cfg["points"]))
    scan = pd.DataFrame([
        optimise_at(predictions, method, model_cfg, daily, float(value)) for value in scan_values
    ])
    edge = collapse_point(scan, 0.0)
    edge_frame = pd.DataFrame([{
        "current_assumed_commission_value_kes": float(raw["commission_value_kes"]),
        **edge,
    }])

    headline.to_csv(OUTPUT_DIR / "commission_sweep.csv", index=False, float_format="%.6g")
    scan.to_csv(OUTPUT_DIR / "commission_sweep_scan.csv", index=False, float_format="%.6g")
    edge_frame.to_csv(OUTPUT_DIR / "commission_collapse_point.csv", index=False, float_format="%.6g")

    pd.set_option("display.width", 240)
    print(headline.round(4).to_string(index=False))
    print()
    print(edge_frame.round(2).to_string(index=False))


if __name__ == "__main__":
    main()
