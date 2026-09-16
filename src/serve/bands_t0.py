"""Cost-optimised operating thresholds for the T0 model.

Usage: python -m src.serve.bands_t0

Phase 6 optimised bands only for the chosen T7 model. This is packaging, not
new modelling: the T0 model was already trained in Phase 4 and its
auto-release performance measured in Phase 5/6 (outputs/auto_release_*.csv).
It runs the exact same procedure as src/eval/bands.py -- same functions,
same cost matrix, same calibration method -- against the T0 model's
predictions instead of the chosen model's. No cost parameter is read,
touched or overridden.

Writes outputs/band_operating_point_t0.csv in the same shape as
outputs/band_operating_point.csv, so src/serve/artifact.py can read either
by picking the file that matches the model it is serialising.
"""

from __future__ import annotations

from typing import Any, Dict

import pandas as pd

from ..eval.bands import mean_surface, operating_point_row, optimum
from ..eval.calibration import load_predictions
from ..eval.costs import load_costs, mean_daily_activations_from_summary
from ..generator import config as config_module

OUTPUT_DIR = config_module.REPO_ROOT / "outputs"
MODEL_NAME = "t0_none"
OUTPUT_PATH = OUTPUT_DIR / "band_operating_point_t0.csv"


def build(model_cfg: Dict[str, Any] | None = None) -> pd.DataFrame:
    model_cfg = model_cfg or config_module.load_config(config_module.MODEL_CONFIG)
    method = str(pd.read_csv(OUTPUT_DIR / "calibration_choice.csv")["chosen_method"].iloc[0])
    predictions = load_predictions(MODEL_NAME)
    daily = mean_daily_activations_from_summary()
    costs = load_costs(daily)  # config/costs.yaml, unchanged, no overrides

    surface = mean_surface(predictions, method, model_cfg, costs)
    unconstrained = optimum(surface, None)
    constrained = optimum(surface, costs.review_capacity_daily_share)
    points = pd.DataFrame([
        operating_point_row(constrained, costs, "chosen (capacity constrained)"),
        operating_point_row(unconstrained, costs, "unconstrained"),
    ])
    points.insert(0, "model", MODEL_NAME)
    points["constraint_cost"] = (
        points["expected_cost_per_activation"] - float(unconstrained["expected_cost"])
    )
    return points


def main() -> None:
    points = build()
    points.to_csv(OUTPUT_PATH, index=False, float_format="%.6g")
    pd.set_option("display.width", 240)
    print(points.round(5).to_string(index=False))


if __name__ == "__main__":
    main()
