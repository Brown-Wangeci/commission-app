"""T0-vs-T7 model disagreement: the payout-before-refusal risk.

Usage: python -m src.eval.disagreement

T0 decides at submission; T7 decides again at hold-close, once the escrow
window has closed, using nine more features the T0 decision never had. The
20-record smoke test in scripts/smoke_test_service.py found zero cases of a
T0 release later judged a T7 reject -- too small a sample to say how often
that happens. This module answers that using the full four-seed Phase 5
evaluation instead of retraining anything.

Scope: this project's cross-validation is time-ordered (train on the earlier
part of each seed's simulated calendar, test on the later part), so only the
later ~50% of each seed's dataset -- the temporal test region -- ever gets an
honest, non-leaked prediction; the earlier, fit-only rows are never scored
out-of-fold anywhere else in this project either, for the same reason. "Every
activation" below means every activation in that test region, across all
four seeds (outputs/multiseed_predictions.parquet), which both t0_none and
t7_none score from the same fold structure per seed -- so the two models'
predictions for a given (seed, activation_id) are directly comparable, not
scored under different train/test splits.

No retraining, no threshold changes: bands come from
outputs/band_operating_point.csv (T7) and outputs/band_operating_point_t0.csv
(T0), the same Phase 6/8 cost-optimised thresholds the service is built on.
"""

from __future__ import annotations

from pathlib import Path
from typing import Dict

import numpy as np
import pandas as pd

from ..generator import config as config_module
from .calibration import load_predictions

OUTPUT_DIR = config_module.REPO_ROOT / "outputs"
BANDS = ("auto_release", "review", "reject")
RATE_COLUMNS = (
    "rate", "fraud_share_of_flagged", "commission_value_kes_share",
    "commission_value_kes_per_1000_activations",
)


def _thresholds(path: Path) -> tuple[float, float]:
    frame = pd.read_csv(path)
    row = frame[frame["variant"] == "chosen (capacity constrained)"].iloc[0]
    return float(row["release_threshold"]), float(row["reject_threshold"])


def assign_band(probability: np.ndarray, release: float, reject: float) -> np.ndarray:
    """Same convention as LoadedArtifact.assign_band: release at or below,
    refuse strictly above, so a boundary case matches the served decision."""
    return np.where(
        probability <= release, "auto_release", np.where(probability <= reject, "review", "reject")
    )


def paired_predictions(method: str) -> pd.DataFrame:
    """One row per (seed, activation_id) with both models' calibrated
    probability and band, for every test-region row of every seed."""
    predictions = load_predictions()
    predictions = predictions[predictions["model"].isin(["t0_none", "t7_none"])]
    t7_release, t7_reject = _thresholds(OUTPUT_DIR / "band_operating_point.csv")
    t0_release, t0_reject = _thresholds(OUTPUT_DIR / "band_operating_point_t0.csv")

    t0 = predictions.loc[predictions["model"] == "t0_none", ["seed", "activation_id", "label", method]]
    t0 = t0.rename(columns={method: "t0_probability"})
    t7 = predictions.loc[predictions["model"] == "t7_none", ["seed", "activation_id", method]]
    t7 = t7.rename(columns={method: "t7_probability"})

    paired = t0.merge(t7, on=["seed", "activation_id"], how="inner")
    if not (len(paired) == len(t0) == len(t7)):
        raise ValueError(
            "t0_none and t7_none test rows are not in 1:1 correspondence per seed -- "
            "the two models were not scored on the same fold structure"
        )

    paired["t0_band"] = assign_band(paired["t0_probability"].to_numpy(dtype=float), t0_release, t0_reject)
    paired["t7_band"] = assign_band(paired["t7_probability"].to_numpy(dtype=float), t7_release, t7_reject)
    return paired


def transition_by_seed(paired: pd.DataFrame) -> pd.DataFrame:
    """For every (t0_band, t7_band) pair, its share of that seed's rows."""
    rows = []
    for seed, group in paired.groupby("seed"):
        total = len(group)
        counts = group.groupby(["t0_band", "t7_band"]).size()
        for t0_band in BANDS:
            for t7_band in BANDS:
                rows.append({
                    "seed": int(seed), "t0_band": t0_band, "t7_band": t7_band,
                    "share": float(counts.get((t0_band, t7_band), 0)) / total,
                })
    return pd.DataFrame(rows)


def transition_summary(by_seed: pd.DataFrame, paired: pd.DataFrame) -> pd.DataFrame:
    """Mean and seed-level spread first; a pooled (all-seeds-combined) share
    alongside it, since seeds do not all contribute the same row count."""
    summary = by_seed.groupby(["t0_band", "t7_band"]).agg(
        share_mean=("share", "mean"),
        share_sd_across_seeds=("share", lambda s: s.std(ddof=1)),
    ).reset_index()
    pooled_counts = paired.groupby(["t0_band", "t7_band"]).size()
    pooled_total = len(paired)
    summary["share_pooled_across_seeds"] = [
        float(pooled_counts.get((row.t0_band, row.t7_band), 0)) / pooled_total
        for row in summary.itertuples()
    ]
    return summary


def flagged_case_stats(paired: pd.DataFrame, context: pd.DataFrame, t0_band: str, t7_band: str) -> pd.DataFrame:
    """Rate, fraud composition and commission value at stake for one
    (t0_band, t7_band) transition, by seed."""
    merged = paired.merge(
        context[["seed", "activation_id", "commission_value"]], on=["seed", "activation_id"], how="left"
    )
    rows = []
    for seed, group in merged.groupby("seed"):
        flagged_mask = (group["t0_band"] == t0_band) & (group["t7_band"] == t7_band)
        flagged = group[flagged_mask]
        total_commission = float(group["commission_value"].sum())
        flagged_commission = float(flagged["commission_value"].sum())
        rows.append({
            "seed": int(seed),
            "n_total": int(len(group)),
            "n_flagged": int(flagged_mask.sum()),
            "rate": float(flagged_mask.mean()),
            "fraud_share_of_flagged": float(flagged["label"].mean()) if len(flagged) else float("nan"),
            "commission_value_kes_flagged": flagged_commission,
            "commission_value_kes_share": flagged_commission / total_commission if total_commission else float("nan"),
            "commission_value_kes_per_1000_activations": flagged_commission / len(group) * 1000.0,
        })
    return pd.DataFrame(rows)


def summarise_rate(by_seed: pd.DataFrame) -> pd.DataFrame:
    """Mean and seed-level spread for each rate/share column, plus the
    pooled count-weighted totals (n_flagged, n_total) across all seeds."""
    means = by_seed[list(RATE_COLUMNS)].mean()
    sds = by_seed[list(RATE_COLUMNS)].std(ddof=1)
    row = {f"{c}_mean": float(means[c]) for c in RATE_COLUMNS}
    row.update({f"{c}_sd_across_seeds": float(sds[c]) for c in RATE_COLUMNS})
    row["n_total_pooled"] = int(by_seed["n_total"].sum())
    row["n_flagged_pooled"] = int(by_seed["n_flagged"].sum())
    row["rate_pooled"] = row["n_flagged_pooled"] / row["n_total_pooled"]
    row["commission_value_kes_flagged_pooled"] = float(by_seed["commission_value_kes_flagged"].sum())
    return pd.DataFrame([row])


def main() -> None:
    method = str(pd.read_csv(OUTPUT_DIR / "calibration_choice.csv")["chosen_method"].iloc[0])
    paired = paired_predictions(method)
    context = pd.read_parquet(OUTPUT_DIR / "multiseed_row_context.parquet")

    transition_seed = transition_by_seed(paired)
    transition_summary_table = transition_summary(transition_seed, paired)

    release_then_reject_seed = flagged_case_stats(paired, context, "auto_release", "reject")
    release_then_reject_summary = summarise_rate(release_then_reject_seed)

    reject_then_release_seed = flagged_case_stats(paired, context, "reject", "auto_release")
    reject_then_release_seed["genuine_share_of_flagged"] = 1.0 - reject_then_release_seed["fraud_share_of_flagged"]
    reject_then_release_summary = summarise_rate(reject_then_release_seed)
    reject_then_release_summary["genuine_share_of_flagged_mean"] = (
        1.0 - reject_then_release_summary["fraud_share_of_flagged_mean"]
    )

    tables = {
        "disagreement_transition_by_seed": transition_seed,
        "disagreement_transition_summary": transition_summary_table,
        "disagreement_release_then_reject_by_seed": release_then_reject_seed,
        "disagreement_release_then_reject_summary": release_then_reject_summary,
        "disagreement_reject_then_release_by_seed": reject_then_release_seed,
        "disagreement_reject_then_release_summary": reject_then_release_summary,
    }
    for name, table in tables.items():
        table.to_csv(OUTPUT_DIR / f"{name}.csv", index=False, float_format="%.6g")

    pd.set_option("display.width", 240)
    print(f"calibration method: {method}")
    print(f"paired test-region rows across {paired['seed'].nunique()} seeds: {len(paired)}")
    print()
    print("band-transition matrix (share of test-region rows, mean across seeds):")
    print(transition_summary_table.round(5).to_string(index=False))
    print()
    print("T0 auto_release -> T7 reject (payout already made):")
    print(release_then_reject_summary.round(5).to_string(index=False))
    print()
    print("T0 reject -> T7 auto_release (refused on evidence the hold window would have cleared):")
    print(reject_then_release_summary.round(5).to_string(index=False))


if __name__ == "__main__":
    main()
