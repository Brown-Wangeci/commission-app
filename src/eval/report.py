"""Command line generation report: python -m src.eval.report

Regenerates the dataset in memory from config and prints the diagnostics.
Nothing here accepts or rejects the dataset.
"""

from __future__ import annotations

from typing import Any, Dict

import pandas as pd

from ..generator import config as config_module
from ..generator.features import T0_FEATURES, T7_FEATURES
from ..generator.run import generate
from . import checks


def aligned_labels(internal_labels: pd.DataFrame, keys: pd.DataFrame) -> pd.DataFrame:
    """Internal labels reordered to match the feature rows."""
    return (
        internal_labels.set_index("activation_id")
        .reindex(keys["activation_id"])
        .reset_index()
    )


def build_report(write: bool = False, cfg: Dict[str, Any] | None = None) -> Dict[str, Any]:
    if cfg is None:
        cfg = config_module.load_config(config_module.GENERATOR_CONFIG)
    model_cfg = config_module.load_config(config_module.MODEL_CONFIG)
    _, internal, features, manifest = generate(write=write, cfg=cfg)

    labels_frame = aligned_labels(internal.labels, features.keys)
    labels = labels_frame["is_fraudulent"].to_numpy().astype(int)
    matrix = pd.concat([features.t0, features.t7], axis=1)

    logreg_folds = checks.cross_validated_logreg(matrix, labels, features.keys, cfg, model_cfg)
    diagnostics = checks.run_diagnostics(matrix, labels, logreg_folds)
    return {
        "manifest": manifest,
        "diagnostics": diagnostics,
        "diagnostics_table": checks.diagnostics_table(diagnostics, cfg),
        "logreg_folds": logreg_folds,
        "auc": checks.single_feature_auc(matrix, labels),
        "correlation": checks.label_correlation(matrix, labels),
        "t7_pearson": checks.t7_correlation(features.t7, "pearson"),
        "t7_spearman": checks.t7_correlation(features.t7, "spearman"),
        "prevalence_floor": checks.prevalence_floor(
            labels_frame, features.keys["timestamp_submitted"], cfg, model_cfg
        ),
        "typologies": checks.typology_counts(internal.labels),
        "ambiguity": checks.ambiguity_counts(internal.labels),
        "flags": checks.flag_counts(internal.labels),
        "labels": labels,
        "matrix": matrix,
    }


def main() -> None:
    pd.set_option("display.width", 200)
    report = build_report(write=False)
    summary = report["manifest"]["summary"]

    print(f"activations            {summary['num_activations']}")
    print(f"agent type counts      {summary['agent_type_counts']}")
    print(f"realised fraud rate    {summary['realised_fraud_rate']:.4f}")
    print(f"ambiguous share        {summary['ambiguous_share']:.4f}")
    print(f"careful fraud records  {summary['careful_fraud_count']}")
    print()
    print("single feature AUC (highest first)")
    group = {name: "T0" for name in T0_FEATURES} | {name: "T7" for name in T7_FEATURES}
    auc = report["auc"]
    table = pd.DataFrame({"auc": auc, "group": [group[n] for n in auc.index]})
    print(table.to_string(float_format=lambda v: f"{v:.3f}"))
    print()
    print("T7 feature correlation (Spearman)")
    print(report["t7_spearman"].round(2).to_string())
    print()
    print("prevalence floor")
    for key, value in report["prevalence_floor"].items():
        print(f"  {key:36s} {value}")
    print()
    print("DIAGNOSTICS (reporting only; nothing is gated on these)")
    print(report["diagnostics_table"].to_string(index=False))


if __name__ == "__main__":
    main()
