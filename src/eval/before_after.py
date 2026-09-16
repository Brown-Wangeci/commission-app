"""Phase 3 against Phase 4: every reported number, before and after the fixes.

Usage: python -m src.eval.before_after

"Before" is read from outputs/phase3_baseline/, which holds the result files
exactly as committed at the end of Phase 3 (commit 043eafa). "After" is read
from outputs/. Nothing is recomputed here, so the comparison cannot drift from
what each run actually produced.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Sequence

import pandas as pd

from ..generator import config as config_module

OUTPUT_DIR = config_module.REPO_ROOT / "outputs"
BASELINE_DIR = OUTPUT_DIR / "phase3_baseline"


def compare(
    name: str, keys: Sequence[str], values: Sequence[str], baseline_name: str | None = None
) -> pd.DataFrame:
    """Join one result file to its Phase 3 counterpart and difference the values."""
    before = pd.read_csv(BASELINE_DIR / f"{baseline_name or name}.csv")
    after = pd.read_csv(OUTPUT_DIR / f"{name}.csv")
    keys, values = list(keys), [v for v in values if v in before.columns and v in after.columns]
    merged = before[keys + values].merge(
        after[keys + values], on=keys, how="outer", suffixes=("_before", "_after")
    )
    for value in values:
        merged[f"{value}_change"] = merged[f"{value}_after"] - merged[f"{value}_before"]
    ordered = keys + [f"{v}_{side}" for v in values for side in ("before", "after", "change")]
    return merged[ordered]


def dataset_summary() -> pd.DataFrame:
    """Dataset-level facts from the two run manifests."""
    before = json.loads((BASELINE_DIR / "run_manifest.json").read_text(encoding="utf-8"))["summary"]
    after = json.loads((OUTPUT_DIR / "run_manifest.json").read_text(encoding="utf-8"))["summary"]
    rows: List[Dict[str, Any]] = []
    plain = ["num_activations", "realised_fraud_rate", "careful_fraud_count", "ambiguous_share",
             "num_customers_used", "num_devices"]
    for key in plain:
        rows.append({"quantity": key, "before": before[key], "after": after[key]})
    for typology, count in after["typology_counts"].items():
        rows.append({"quantity": f"typology_count_{typology}",
                     "before": before["typology_counts"].get(typology), "after": count})
    for honesty_type, count in after["agent_type_counts"].items():
        rows.append({"quantity": f"agents_{honesty_type}",
                     "before": before["agent_type_counts"].get(honesty_type), "after": count})
    table = pd.DataFrame(rows)
    table["change"] = pd.to_numeric(table["after"], errors="coerce") - pd.to_numeric(
        table["before"], errors="coerce"
    )
    return table


def mix_decomposition() -> pd.DataFrame:
    """Split the change in overall recall into "the mix changed" and "detection changed".

    Overall recall at a precision target is the positives-weighted average of the
    per-typology recalls. The typologies differ enormously in detectability, so a
    shift in which typologies the fraud is made of moves overall recall without
    any change in detection. Holding the Phase 3 mix fixed isolates the rest.

    This reconstructs overall recall from per-typology means, so it differs by a
    little from the directly measured recall; the reconstruction is reported
    alongside so the size of that approximation is visible.
    """
    before = pd.read_csv(BASELINE_DIR / "typology_recall_summary.csv")
    after = pd.read_csv(OUTPUT_DIR / "typology_recall_summary.csv")
    measured = compare("cv_summary", ["model"], ["recall_at_p90_mean", "recall_at_p95_mean"])
    rows = []
    for (model, target), group_after in after.groupby(["model", "precision_target"]):
        group_before = before[(before["model"] == model) & (before["precision_target"] == target)]
        merged = group_before.merge(group_after, on="typology", suffixes=("_before", "_after"))
        share_before = merged["n_positive_mean_before"] / merged["n_positive_mean_before"].sum()
        share_after = merged["n_positive_mean_after"] / merged["n_positive_mean_after"].sum()
        reconstructed_before = float((share_before * merged["recall_mean_before"]).sum())
        reconstructed_after = float((share_after * merged["recall_mean_after"]).sum())
        at_before_mix = float((share_before * merged["recall_mean_after"]).sum())
        column = f"recall_at_p{int(target * 100)}_mean"
        row = measured[measured["model"] == model].iloc[0]
        rows.append({
            "model": model, "precision_target": target,
            "measured_before": row[f"{column}_before"], "measured_after": row[f"{column}_after"],
            "reconstructed_before": reconstructed_before, "reconstructed_after": reconstructed_after,
            "after_at_before_mix": at_before_mix,
            "change_total": reconstructed_after - reconstructed_before,
            "change_from_detection": at_before_mix - reconstructed_before,
            "change_from_typology_mix": reconstructed_after - at_before_mix,
        })
    return pd.DataFrame(rows)


def build() -> Dict[str, pd.DataFrame]:
    metrics = ["prevalence_mean", "pr_auc_mean", "pr_auc_sd", "roc_auc_mean",
               "recall_at_p90_mean", "recall_at_p90_sd", "recall_at_p95_mean", "recall_at_p95_sd"]
    return {
        "before_after_dataset": dataset_summary(),
        "before_after_results": compare("cv_summary", ["model"], metrics),
        "before_after_typology_recall": compare(
            "typology_recall_summary", ["model", "precision_target", "typology"],
            ["recall_mean", "recall_sd", "n_positive_mean", "n_positive_min"],
        ),
        "before_after_mix_decomposition": mix_decomposition(),
        "before_after_paired_differences": compare(
            "paired_differences_summary", ["comparison"],
            ["pr_auc_diff_mean", "pr_auc_diff_sd", "recall_at_p90_diff_mean", "pr_auc_folds_first_better"],
        ),
        "before_after_false_positive_sources": compare(
            "investigation_false_positive_sources", ["model", "precision_target", "honesty_type"],
            ["share_of_false_positives_mean", "share_of_legitimate_test_rows_mean", "false_positives_mean"],
        ),
        "before_after_latency_tail": compare(
            "investigation_acceptance_latency_tail", ["latency_above_hours"],
            ["fraud_share_above", "share_of_legitimate_above", "share_of_payout_gaming_above"],
        ),
        "before_after_diagnostics": compare("diagnostics", ["check"], ["value", "sd_across_folds"]),
        "before_after_rules": compare(
            "rules_baseline_rule_statistics", ["rule"], ["fired_share", "precision", "recall"]
        ),
        "before_after_single_feature_auc": compare("single_feature_auc", ["feature"], ["auc", "label_correlation"]),
    }


def main() -> None:
    pd.set_option("display.width", 250)
    pd.set_option("display.max_columns", 40)
    pd.set_option("display.max_rows", 200)
    for name, table in build().items():
        table.to_csv(OUTPUT_DIR / f"{name}.csv", index=False, float_format="%.6g")
        print(f"== {name} ==")
        print(table.round(4).to_string(index=False))
        print()


if __name__ == "__main__":
    main()
