"""Phase 5 against Phase 6: what the corrected cost model changed.

Usage: python -m src.eval.band_comparison

"Before" is read from outputs/phase5_baseline/, the band and fairness results as
they stood under the single false-positive cost and the assumption that every
review was correct. "After" is the current outputs/. Nothing is recomputed here,
so the comparison cannot drift from what each run produced.
"""

from __future__ import annotations

from typing import Dict

import pandas as pd

from ..generator import config as config_module

OUTPUT_DIR = config_module.REPO_ROOT / "outputs"
BASELINE_DIR = OUTPUT_DIR / "phase5_baseline"


def operating_point() -> pd.DataFrame:
    before = pd.read_csv(BASELINE_DIR / "band_operating_point.csv").iloc[0]
    after = pd.read_csv(OUTPUT_DIR / "band_operating_point.csv").iloc[0]
    fields = [
        "release_threshold", "reject_threshold", "released_share", "review_share", "reject_share",
        "reject_precision", "reject_recall", "released_fraud_share_of_all_fraud",
        "expected_cost_per_activation",
    ]
    rows = []
    for field in fields:
        rows.append({
            "quantity": field,
            "phase5": float(before[field]),
            "phase6": float(after[field]),
            "change": float(after[field]) - float(before[field]),
        })
    return pd.DataFrame(rows)


def fairness_by_honesty() -> pd.DataFrame:
    before = pd.read_csv(BASELINE_DIR / "fairness_bands_by_honesty.csv")
    after = pd.read_csv(OUTPUT_DIR / "fairness_bands_by_honesty.csv")
    merged = before.merge(after, on=["honesty_type", "band"], suffixes=("_phase5", "_phase6"))
    merged["change"] = merged["share_mean_phase6"] - merged["share_mean_phase5"]
    merged["relative_change"] = merged["change"] / merged["share_mean_phase5"].replace(0.0, float("nan"))
    return merged[[
        "honesty_type", "band", "share_mean_phase5", "share_mean_phase6", "change", "relative_change",
        "share_sd_across_seeds_phase6",
    ]].sort_values(["band", "honesty_type"])


def fairness_by_situation() -> pd.DataFrame:
    before = pd.read_csv(BASELINE_DIR / "fairness_bands_by_situation.csv")
    after = pd.read_csv(OUTPUT_DIR / "fairness_bands_by_situation.csv")
    keys = ["population", "situation", "band"]
    merged = before.merge(after, on=keys, suffixes=("_phase5", "_phase6"))
    merged["change"] = merged["share_mean_phase6"] - merged["share_mean_phase5"]
    return merged[keys + ["share_mean_phase5", "share_mean_phase6", "change"]]


def held_totals(situation: pd.DataFrame) -> pd.DataFrame:
    """Review plus reject, the share of genuine work that does not simply clear."""
    held = situation[situation["band"] != "auto-released"]
    grouped = held.groupby(["population", "situation"])[["share_mean_phase5", "share_mean_phase6"]].sum()
    grouped["change"] = grouped["share_mean_phase6"] - grouped["share_mean_phase5"]
    return grouped.reset_index().sort_values("share_mean_phase6", ascending=False)


def queue() -> pd.DataFrame:
    before = pd.read_csv(BASELINE_DIR / "fairness_queue.csv").iloc[0]
    after = pd.read_csv(OUTPUT_DIR / "fairness_queue.csv").iloc[0]
    fields = ["review_share_of_volume", "daily_review_arrivals", "utilisation",
              "mean_wait_days_for_a_reviewed_activation"]
    return pd.DataFrame([
        {"quantity": field, "phase5": float(before[field]), "phase6": float(after[field])}
        for field in fields
    ])


def main() -> None:
    tables: Dict[str, pd.DataFrame] = {
        "comparison_operating_point": operating_point(),
        "comparison_fairness_by_honesty": fairness_by_honesty(),
        "comparison_fairness_by_situation": fairness_by_situation(),
        "comparison_fairness_held_totals": held_totals(fairness_by_situation()),
        "comparison_queue": queue(),
    }
    for name, table in tables.items():
        table.to_csv(OUTPUT_DIR / f"{name}.csv", index=False, float_format="%.6g")

    pd.set_option("display.width", 240)
    print("== operating point ==")
    print(tables["comparison_operating_point"].round(5).to_string(index=False))
    print()
    print("== genuine activations by agent type ==")
    print(tables["comparison_fairness_by_honesty"].round(5).to_string(index=False))
    print()
    print("== honest agents, held (review or reject), by situation ==")
    honest = tables["comparison_fairness_held_totals"]
    print(honest[honest["population"] == "honest agents only"].round(5).to_string(index=False))


if __name__ == "__main__":
    main()
