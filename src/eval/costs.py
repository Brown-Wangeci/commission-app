"""The cost matrix, with the derived entries computed rather than copied.

Usage: python -m src.eval.costs

`review` and `review_capacity_daily_share` are not written down in
config/costs.yaml as bare numbers: they are computed here from the reviewer
wage, the review time and the activation volume, so a report can never quote a
value that the components do not produce.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict

import pandas as pd

from ..generator import config as config_module

COSTS_CONFIG = config_module.REPO_ROOT / "config" / "costs.yaml"
OUTPUT_DIR = config_module.REPO_ROOT / "outputs"
MINUTES_PER_HOUR = 60.0


@dataclass(frozen=True)
class Costs:
    """All costs in units of one agent commission."""

    false_negative: float
    false_positive: float
    review: float
    true_negative: float
    review_capacity_daily_share: float
    reviewers: int
    reviews_per_reviewer_day: float
    mean_daily_activations: float
    commission_value_kes: float
    loaded_hourly_rate_kes: float
    raw: Dict[str, Any]

    def band_costs(self) -> Dict[str, float]:
        return {"false_negative": self.false_negative, "false_positive": self.false_positive,
                "review": self.review, "true_negative": self.true_negative}


def reviews_per_day(raw: Dict[str, Any], reviewers: int) -> float:
    per_reviewer = float(raw["reviewer_productive_hours_per_day"]) * MINUTES_PER_HOUR / float(raw["review_minutes"])
    return per_reviewer * reviewers


def load_costs(
    mean_daily_activations: float,
    reviewers: int | None = None,
    overrides: Dict[str, float] | None = None,
) -> Costs:
    """Read config/costs.yaml and compute the derived entries.

    `mean_daily_activations` comes from the generated data, so the capacity
    share is a property of this dataset rather than a guess.
    """
    raw = config_module.load_config(COSTS_CONFIG)
    overrides = dict(overrides or {})
    staffing = int(raw["reviewers"] if reviewers is None else reviewers)

    hourly = float(raw["reviewer_monthly_cost_kes"]) / float(raw["working_hours_per_month"])
    commission_value = float(overrides.pop("commission_value_kes", raw["commission_value_kes"]))
    review = float(raw["review_minutes"]) / MINUTES_PER_HOUR * hourly / commission_value
    per_day = reviews_per_day(raw, staffing)
    capacity = per_day / mean_daily_activations

    values = {
        "false_negative": float(raw["false_negative"]),
        "false_positive": float(raw["false_positive"]),
        "review": review,
        "true_negative": float(raw["true_negative"]),
        "review_capacity_daily_share": capacity,
    }
    values.update({key: float(value) for key, value in overrides.items() if key in values})
    return Costs(
        **values,
        reviewers=staffing,
        reviews_per_reviewer_day=per_day / staffing,
        mean_daily_activations=mean_daily_activations,
        commission_value_kes=commission_value,
        loaded_hourly_rate_kes=hourly,
        raw=raw,
    )


def derivation_table(costs: Costs) -> pd.DataFrame:
    """Every cost with how it was arrived at, for the write-up."""
    raw = costs.raw
    rows = [
        {"quantity": "commission", "value": 1.0, "unit": "commission",
         "derivation": "the unit of account"},
        {"quantity": "false_negative", "value": costs.false_negative, "unit": "commissions",
         "derivation": "commission paid on non-existent work, unrecoverable onboarding and investigation; "
                       "CBK 2025 reports about four fifths of fraud-exposed value unrecovered"},
        {"quantity": "false_positive", "value": costs.false_positive, "unit": "commissions",
         "derivation": "review cost plus P(churn after an unjust delay) times replacement cost"},
        {"quantity": "loaded_hourly_rate_kes", "value": costs.loaded_hourly_rate_kes, "unit": "KSh per hour",
         "derivation": f"{raw['reviewer_monthly_cost_kes']} KSh per month / {raw['working_hours_per_month']} hours"},
        {"quantity": "commission_value_kes", "value": costs.commission_value_kes, "unit": "KSh",
         "derivation": "generator mean escrow times commission_rate; least-sourced input in the file"},
        {"quantity": "review", "value": costs.review, "unit": "commissions",
         "derivation": f"{raw['review_minutes']} min / 60 * {costs.loaded_hourly_rate_kes:.2f} KSh per hour "
                       f"/ {costs.commission_value_kes:.2f} KSh per commission"},
        {"quantity": "reviews_per_reviewer_day", "value": costs.reviews_per_reviewer_day, "unit": "reviews",
         "derivation": f"{raw['reviewer_productive_hours_per_day']} productive hours * 60 / {raw['review_minutes']} min"},
        {"quantity": "mean_daily_activations", "value": costs.mean_daily_activations, "unit": "activations",
         "derivation": "mean across the seeds of activations divided by simulated days"},
        {"quantity": "review_capacity_daily_share", "value": costs.review_capacity_daily_share, "unit": "share of volume",
         "derivation": f"{costs.reviewers} reviewer(s) * {costs.reviews_per_reviewer_day:.0f} reviews "
                       f"/ {costs.mean_daily_activations:.0f} activations per day"},
    ]
    table = pd.DataFrame(rows)
    stated = {"review": raw.get("review"), "false_negative": raw.get("false_negative")}
    table["stated_in_brief"] = table["quantity"].map(stated)
    return table


def mean_daily_activations_from_summary() -> float:
    summary = pd.read_csv(OUTPUT_DIR / "multiseed_seed_summary.csv")
    return float(summary["mean_daily_activations"].mean())


def main() -> None:
    costs = load_costs(mean_daily_activations_from_summary())
    table = derivation_table(costs)
    table.to_csv(OUTPUT_DIR / "cost_matrix.csv", index=False, float_format="%.6g")
    pd.set_option("display.width", 220)
    pd.set_option("display.max_colwidth", 90)
    print(table.round(4).to_string(index=False))


if __name__ == "__main__":
    main()
