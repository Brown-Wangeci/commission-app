"""Is collusion genuinely hard, or accidentally under-specified?

Usage: python -m src.eval.collusion_check

Collusion is designed to hide inside the legitimate trial-then-lapse population:
a real customer who signs up, uses the service briefly and stops. This module
compares the two populations feature by feature (single-feature AUC and an
overlap coefficient) and then asks whether any classifier can separate them at
all, using agent-grouped cross-validation so it cannot simply learn which agents
are dishonest.

A single-feature AUC near 0.5 and an overlap near 1 mean the two populations are
the same shape on that feature, which is the intended design.
"""

from __future__ import annotations

from typing import Any, Dict

import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import GroupKFold
from xgboost import XGBClassifier

from ..generator import config as config_module
from ..train import data as data_module

OUTPUT_DIR = config_module.REPO_ROOT / "outputs"

# Features that describe the agent's recent history rather than this activation
# or its customer. Differences here say who commits collusion, not what a
# collusive activation looks like.
AGENT_HISTORY_FEATURES = (
    "agent_tenure_days",
    "agent_activation_velocity_1h",
    "agent_activation_velocity_24h",
    "device_activations_7d",
    "device_shared_agent_count_30d",
    "distinct_devices_used_30d",
)


def overlap_coefficient(left: np.ndarray, right: np.ndarray, bins: int) -> float:
    """Histogram intersection on shared bins: 1.0 means identical distributions."""
    edges = np.histogram_bin_edges(np.concatenate([left, right]), bins=bins)
    left_density, _ = np.histogram(left, bins=edges, density=False)
    right_density, _ = np.histogram(right, bins=edges, density=False)
    left_share = left_density / max(left_density.sum(), 1)
    right_share = right_density / max(right_density.sum(), 1)
    return float(np.minimum(left_share, right_share).sum())


def feature_comparison(
    dataset: data_module.Dataset, model_cfg: Dict[str, Any]
) -> pd.DataFrame:
    """Collusion against legitimate trial-lapse, and against all legitimate rows."""
    bins = int(model_cfg["investigations"]["overlap_histogram_bins"])
    collusion = dataset.typology == "collusion"
    trial_lapse = dataset.mode == "legit_trial_lapse"
    legitimate = dataset.labels == 0
    rows = []
    for name in dataset.features.columns:
        values = dataset.features[name].to_numpy(dtype=float)
        against = {"trial_lapse": trial_lapse, "all_legitimate": legitimate}
        row: Dict[str, Any] = {
            "feature": name,
            "group": "agent history" if name in AGENT_HISTORY_FEATURES else "activation or customer",
            "collusion_median": float(np.median(values[collusion])),
            "trial_lapse_median": float(np.median(values[trial_lapse])),
            "all_legitimate_median": float(np.median(values[legitimate])),
        }
        for label, reference in against.items():
            paired = np.concatenate([values[collusion], values[reference]])
            target = np.concatenate([np.ones(collusion.sum()), np.zeros(reference.sum())])
            auc = roc_auc_score(target, paired) if np.ptp(paired) > 0 else 0.5
            row[f"auc_vs_{label}"] = float(max(auc, 1.0 - auc))
            row[f"overlap_vs_{label}"] = overlap_coefficient(values[collusion], values[reference], bins)
        rows.append(row)
    return pd.DataFrame(rows).sort_values("auc_vs_trial_lapse", ascending=False).reset_index(drop=True)


def separability(dataset: data_module.Dataset, model_cfg: Dict[str, Any]) -> pd.DataFrame:
    """Can a model tell collusion from trial-lapse at all, grouped by agent?"""
    collusion = dataset.typology == "collusion"
    trial_lapse = dataset.mode == "legit_trial_lapse"
    selected = collusion | trial_lapse
    labels = collusion[selected].astype(int)
    agents = dataset.keys["agent_id"].to_numpy()[selected]
    n_folds = int(model_cfg["cross_validation"]["n_folds"])
    seed = int(model_cfg["cross_validation"]["cv_seed"])
    rows = []
    for feature_set in ("all_features", "activation_and_customer_only"):
        matrix = dataset.features[selected]
        if feature_set == "activation_and_customer_only":
            matrix = matrix.drop(columns=list(AGENT_HISTORY_FEATURES))
        for fold, (train, test) in enumerate(GroupKFold(n_splits=n_folds).split(matrix, labels, agents)):
            model = XGBClassifier(
                **{k: float(v) if k == "learning_rate" else int(v)
                   for k, v in model_cfg["investigations"]["collusion_probe"].items()},
                tree_method=str(model_cfg["xgboost"]["tree_method"]),
                n_jobs=int(model_cfg["xgboost"]["n_jobs"]), random_state=seed,
            )
            model.fit(matrix.iloc[train], labels[train])
            scores = model.predict_proba(matrix.iloc[test])[:, 1]
            rows.append({
                "feature_set": feature_set, "fold": fold,
                "n_collusion": int(labels[test].sum()), "n_trial_lapse": int((labels[test] == 0).sum()),
                "roc_auc": float(roc_auc_score(labels[test], scores)),
            })
    return pd.DataFrame(rows)


def main() -> None:
    model_cfg = config_module.load_config(config_module.MODEL_CONFIG)
    dataset = data_module.load_dataset()
    comparison = feature_comparison(dataset, model_cfg)
    folds = separability(dataset, model_cfg)
    summary = folds.groupby("feature_set")["roc_auc"].agg(["mean", "std", "size"]).reset_index()

    comparison.to_csv(OUTPUT_DIR / "collusion_overlap.csv", index=False, float_format="%.6g")
    folds.to_csv(OUTPUT_DIR / "collusion_separability_by_fold.csv", index=False, float_format="%.6g")
    pd.set_option("display.width", 250)
    pd.set_option("display.max_columns", 30)
    print("collusion against legitimate trial-lapse, feature by feature")
    print(comparison.round(3).to_string(index=False))
    print()
    print("can a model separate collusion from trial-lapse at all (agent-grouped)")
    print(summary.round(4).to_string(index=False))


if __name__ == "__main__":
    main()
