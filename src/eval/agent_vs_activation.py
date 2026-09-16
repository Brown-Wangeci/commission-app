"""How much of the model's performance is identifying risky agents?

Usage: python -m src.eval.agent_vs_activation   (after python -m src.train.run)

E1: retrain the chosen model with every agent-history feature removed (tenure,
both velocity windows, device counts, distinct devices), leaving only what is
observable about this activation and its customer. The PR-AUC gap is how much
of the score depends on the agent's recent history rather than this activation.

E2: the false-positive RATE among legitimate activations, separately for honest,
opportunistic and systematic agents. Phase 3 reported the composition of false
positives; a rate says how likely each group is to have a genuine payout held.

Honesty type is a hidden generator variable, read here for evaluation only.
"""

from __future__ import annotations

from typing import Any, Dict, List

import numpy as np
import pandas as pd

from ..generator import config as config_module
from ..train import data as data_module
from ..train.models import fit_xgboost
from ..train.search import sample_candidates, search_xgboost
from .cv import build_folds, derived_seed
from .metrics import fold_metrics, threshold_at_precision
from .results import OUTPUT_DIR, load_predictions

HONESTY_TYPES = ("honest", "opportunistic", "systematic")


def ablation(
    dataset: data_module.Dataset, gen_cfg: Dict[str, Any], model_cfg: Dict[str, Any], method: str
) -> pd.DataFrame:
    """The chosen model on each feature set, same folds and same search procedure."""
    xgb_cfg = model_cfg["xgboost"]
    targets = [float(t) for t in model_cfg["reporting"]["precision_targets"]]
    seed = int(model_cfg["cross_validation"]["cv_seed"])
    feature_sets = [str(name) for name in model_cfg["investigations"]["ablation_feature_sets"]]
    rows: List[Dict[str, Any]] = []
    for fold in build_folds(dataset.keys, dataset.labels, gen_cfg, model_cfg):
        rng = np.random.default_rng(derived_seed(seed, fold.repeat, fold.fold, 1))
        candidates = sample_candidates(xgb_cfg["search_space"], int(xgb_cfg["search_iterations"]), rng)
        fold_seed = derived_seed(seed, fold.repeat, fold.fold)
        for feature_set in feature_sets:
            matrix = dataset.matrix(feature_set)
            search = search_xgboost(
                (matrix.iloc[fold.inner_train_index], dataset.labels[fold.inner_train_index]),
                (matrix.iloc[fold.inner_val_index], dataset.labels[fold.inner_val_index]),
                candidates, method, model_cfg, fold_seed,
            )
            model = fit_xgboost(
                matrix.iloc[fold.train_index], dataset.labels[fold.train_index],
                search.best, method, model_cfg, fold_seed,
            )
            scores = model.predict_proba(matrix.iloc[fold.test_index])[:, 1]
            rows.append({
                "feature_set": feature_set, "n_features": matrix.shape[1],
                "repeat": fold.repeat, "fold": fold.fold,
                **fold_metrics(dataset.labels[fold.test_index], scores, targets),
            })
        print(f"repeat {fold.repeat} fold {fold.fold} ablated")
    return pd.DataFrame(rows)


def false_positive_rates(
    dataset: data_module.Dataset, model: str, targets: List[float]
) -> pd.DataFrame:
    """Share of each group's legitimate activations that get flagged."""
    predictions = load_predictions(dataset)
    predictions = predictions[predictions["model"] == model]
    honesty = pd.Series(dataset.honesty_type, index=dataset.keys["activation_id"])
    predictions = predictions.assign(honesty_type=predictions["activation_id"].map(honesty).to_numpy())
    rows = []
    for (repeat, fold), group in predictions.groupby(["repeat", "fold"]):
        labels = group["label"].to_numpy()
        scores = group["score"].to_numpy(dtype=float)
        for target in targets:
            threshold = threshold_at_precision(labels, scores, target)
            flagged = np.zeros(len(group), dtype=bool) if threshold is None else scores >= threshold
            for honesty_type in HONESTY_TYPES:
                members = (group["honesty_type"].to_numpy() == honesty_type) & (labels == 0)
                rows.append({
                    "model": model, "repeat": repeat, "fold": fold, "precision_target": target,
                    "honesty_type": honesty_type,
                    "legitimate_rows": int(members.sum()),
                    "false_positives": int((flagged & members).sum()),
                    "false_positive_rate": float(flagged[members].mean()) if members.any() else np.nan,
                })
    return pd.DataFrame(rows)


def main() -> None:
    gen_cfg = config_module.load_config(config_module.GENERATOR_CONFIG)
    model_cfg = config_module.load_config(config_module.MODEL_CONFIG)
    targets = [float(t) for t in model_cfg["reporting"]["precision_targets"]]
    method = str(model_cfg["investigations"]["chosen_imbalance_method"])
    data_module.check_provenance()
    dataset = data_module.load_dataset()

    rates = false_positive_rates(dataset, f"xgb_t7_{method}", targets)
    rate_summary = (
        rates.groupby(["precision_target", "honesty_type"])
        .agg(false_positive_rate_mean=("false_positive_rate", "mean"),
             false_positive_rate_sd=("false_positive_rate", lambda s: s.std(ddof=1)),
             legitimate_rows_mean=("legitimate_rows", "mean"),
             false_positives_mean=("false_positives", "mean"))
        .reset_index()
    )
    folds = ablation(dataset, gen_cfg, model_cfg, method)
    columns = ["pr_auc", "roc_auc", *[f"recall_at_p{int(t * 100)}" for t in targets]]
    grouped = folds.groupby(["feature_set", "n_features"], sort=False)[columns]
    ablation_summary = pd.concat(
        [grouped.mean().add_suffix("_mean"), grouped.std(ddof=1).add_suffix("_sd")], axis=1
    ).reset_index()

    for name, table in {
        "false_positive_rate_by_honesty_by_fold": rates,
        "false_positive_rate_by_honesty": rate_summary,
        "agent_history_ablation_by_fold": folds,
        "agent_history_ablation": ablation_summary,
    }.items():
        table.to_csv(OUTPUT_DIR / f"{name}.csv", index=False, float_format="%.6g")

    pd.set_option("display.width", 250)
    print("E2: false positive rate among legitimate activations, by agent honesty type")
    print(rate_summary.round(4).to_string(index=False))
    print()
    print("E1: agent-history ablation")
    print(ablation_summary.round(4).to_string(index=False))


if __name__ == "__main__":
    main()
