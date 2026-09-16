"""Who the chosen bands actually hold, and for how long.

Usage: python -m src.eval.fairness

Phase 4 measured this at a fixed precision operating point. The bands are now
set by cost, so the question has to be asked again where the system would really
sit: of the activations that are genuine, which agents' work lands in review or
rejection, and how long is the money held.

Waiting time uses an M/D/1 queue (Poisson arrivals, fixed nine-minute reviews),
which is a standard approximation and not a measurement of anything.

This characterises the problem. It does not fix it.
"""

from __future__ import annotations

from typing import Any, Dict

import numpy as np
import pandas as pd

from ..generator import config as config_module
from .calibration import load_predictions
from .costs import load_costs, mean_daily_activations_from_summary

OUTPUT_DIR = config_module.REPO_ROOT / "outputs"
HONESTY_ORDER = ("honest", "opportunistic", "systematic")


def assign_bands(probabilities: np.ndarray, release: float, reject: float) -> np.ndarray:
    """Released at or below the release threshold, rejected strictly above the
    reject threshold, reviewed in between.

    The convention matters because isotonic calibration maps many activations to
    exactly the same probability, so a threshold often lands on a plateau. It is
    the same convention the cost surface and the auto-release measurement use.
    """
    return np.where(
        probabilities <= release, "auto-released",
        np.where(probabilities <= reject, "review", "reject"),
    )


def queue_wait_days(review_share: float, capacity_per_day: float, daily_volume: float,
                    floor_days: float, cap_days: float) -> float:
    """Mean wait for one reviewed activation under an M/D/1 queue.

    Wq = rho / (2 * mu * (1 - rho)) with mu the daily service rate. Above full
    utilisation the queue has no steady state, so the wait is reported as capped
    rather than given a fabricated number.
    """
    arrivals = review_share * daily_volume
    utilisation = arrivals / capacity_per_day
    if utilisation >= 1.0:
        return cap_days
    wait = utilisation / (2.0 * capacity_per_day * (1.0 - utilisation))
    return float(min(max(wait, floor_days), cap_days))


def genuine_rows(predictions: pd.DataFrame, context: pd.DataFrame, method: str) -> pd.DataFrame:
    merged = predictions.merge(context, on=["seed", "activation_id"], how="left")
    merged = merged.rename(columns={method: "probability"})
    return merged[merged["label"] == 0].reset_index(drop=True)


def band_shares(frame: pd.DataFrame, group_column: str) -> pd.DataFrame:
    """Share of each group's genuine activations in each band, per seed then averaged."""
    counts = frame.groupby(["seed", group_column, "band"]).size().rename("rows").reset_index()
    counts["share"] = counts["rows"] / counts.groupby(["seed", group_column])["rows"].transform("sum")
    summary = counts.groupby([group_column, "band"]).agg(
        share_mean=("share", "mean"), share_sd_across_seeds=("share", lambda s: s.std(ddof=1))
    ).reset_index()
    counts = frame.groupby([group_column]).size().rename("genuine_rows_all_seeds").reset_index()
    return summary.merge(counts, on=group_column)


def situation_shares(frame: pd.DataFrame, honest_only: bool) -> pd.DataFrame:
    """The same split by lookalike situation rather than by agent type."""
    rows = []
    subset = frame[frame["honesty_type"] == "honest"] if honest_only else frame
    flags = [c for c in subset.columns if c.startswith("flag_")]
    for flag in flags + ["any_situation", "no_situation"]:
        if flag == "any_situation":
            members = subset[flags].any(axis=1)
        elif flag == "no_situation":
            members = ~subset[flags].any(axis=1)
        else:
            members = subset[flag].astype(bool)
        selected = subset[members]
        if selected.empty:
            continue
        per_seed = selected.groupby(["seed", "band"]).size().rename("rows").reset_index()
        per_seed["share"] = per_seed["rows"] / per_seed.groupby("seed")["rows"].transform("sum")
        for band, group in per_seed.groupby("band"):
            rows.append({
                "population": "honest agents only" if honest_only else "all genuine activations",
                "situation": flag.replace("flag_", ""),
                "band": band,
                "share_mean": float(group["share"].mean()),
                "share_sd_across_seeds": float(group["share"].std(ddof=1)),
                "genuine_rows_all_seeds": int(len(selected)),
            })
    return pd.DataFrame(rows)


def delay_table(shares: pd.DataFrame, group_column: str, wait_days: float,
                cap_days: float) -> pd.DataFrame:
    """Expected extra payout delay for a genuine activation of each group."""
    pivot = shares.pivot_table(index=group_column, columns="band", values="share_mean").fillna(0.0)
    for band in ("auto-released", "review", "reject"):
        if band not in pivot.columns:
            pivot[band] = 0.0
    table = pivot.reset_index()
    table["expected_extra_delay_days"] = table["review"] * wait_days
    table["share_withheld_pending_appeal"] = table["reject"]
    table["note"] = (
        f"review adds {wait_days:.2f} days on average; a rejected genuine activation is "
        f"withheld rather than delayed, so it is reported as a share, not in days "
        f"(cap {cap_days:.0f} days)"
    )
    return table


def main() -> None:
    model_cfg = config_module.load_config(config_module.MODEL_CONFIG)
    method = str(pd.read_csv(OUTPUT_DIR / "calibration_choice.csv")["chosen_method"].iloc[0])
    point = pd.read_csv(OUTPUT_DIR / "band_operating_point.csv").iloc[0]
    release, reject = float(point["release_threshold"]), float(point["reject_threshold"])

    predictions = load_predictions(str(model_cfg["multi_seed"]["chosen_model"]))
    context = pd.read_parquet(OUTPUT_DIR / "multiseed_row_context.parquet")
    frame = genuine_rows(predictions, context, method)
    frame["band"] = assign_bands(frame["probability"].to_numpy(dtype=float), release, reject)

    daily = mean_daily_activations_from_summary()
    costs = load_costs(daily)
    queue_cfg = costs.raw["queue"]
    capacity_per_day = costs.reviews_per_reviewer_day * costs.reviewers
    review_share = float(point["review_share"])
    wait = queue_wait_days(
        review_share, capacity_per_day, daily,
        float(queue_cfg["same_day_mean_wait_days"]), float(queue_cfg["max_reportable_wait_days"]),
    )

    by_honesty = band_shares(frame, "honesty_type")
    by_situation = pd.concat(
        [situation_shares(frame, True), situation_shares(frame, False)], ignore_index=True
    )
    delays = delay_table(by_honesty, "honesty_type", wait, float(queue_cfg["max_reportable_wait_days"]))
    queue = pd.DataFrame([{
        "review_share_of_volume": review_share,
        "daily_activations": daily,
        "daily_review_arrivals": review_share * daily,
        "daily_review_capacity": capacity_per_day,
        "utilisation": review_share * daily / capacity_per_day,
        "mean_wait_days_for_a_reviewed_activation": wait,
        "model": "M/D/1, Poisson arrivals and fixed review time",
    }])

    for name, table in {
        "fairness_bands_by_honesty": by_honesty,
        "fairness_bands_by_situation": by_situation,
        "fairness_expected_delay": delays,
        "fairness_queue": queue,
    }.items():
        table.to_csv(OUTPUT_DIR / f"{name}.csv", index=False, float_format="%.6g")

    pd.set_option("display.width", 240)
    print(by_honesty.round(5).to_string(index=False))
    print()
    print(delays.round(4).to_string(index=False))
    print()
    print(queue.round(4).to_string(index=False))


if __name__ == "__main__":
    main()
