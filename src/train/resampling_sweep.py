"""Resampling methods compared at matched effective minority ratios.

Usage: python -m src.train.resampling_sweep

The Phase 3 comparison was not interpretable: SMOTE oversampled to a minority
ratio of 0.30 (about a 4x upweighting) while scale_pos_weight weighted to full
balance (about 14x), so it compared two methods at two different strengths.

Here the effective minority-to-majority ratio is the axis, and every method is
run at every ratio. To keep the comparison neutral, the hyperparameters for a
fold are chosen once by the usual inner search with NO class handling at all,
then held fixed across every method and ratio in that fold. Otherwise the search
would be run under one method's conditions and hand it an advantage.
"""

from __future__ import annotations

from typing import Any, Dict, List

import numpy as np
import pandas as pd

from ..eval.cv import build_folds, derived_seed
from ..eval.metrics import fold_metrics
from ..generator import config as config_module
from . import data as data_module
from .models import fit_xgboost
from .search import sample_candidates, search_xgboost

OUTPUT_DIR = config_module.REPO_ROOT / "outputs"
FEATURE_SET = "t7"


def neutral_hyperparameters(
    dataset: data_module.Dataset, fold, model_cfg: Dict[str, Any], seed: int
) -> Dict[str, float]:
    """Inner search with no resampling and no weighting, so no method is favoured."""
    xgb_cfg = model_cfg["xgboost"]
    rng = np.random.default_rng(derived_seed(seed, fold.repeat, fold.fold, 1))
    candidates = sample_candidates(xgb_cfg["search_space"], int(xgb_cfg["search_iterations"]), rng)
    matrix = dataset.matrix(FEATURE_SET)
    search = search_xgboost(
        (matrix.iloc[fold.inner_train_index], dataset.labels[fold.inner_train_index]),
        (matrix.iloc[fold.inner_val_index], dataset.labels[fold.inner_val_index]),
        candidates, "none", model_cfg, seed,
    )
    return search.best


def sweep(dataset: data_module.Dataset, gen_cfg: Dict[str, Any], model_cfg: Dict[str, Any]) -> pd.DataFrame:
    sweep_cfg = model_cfg["resampling"]["sweep"]
    ratios = [float(r) for r in sweep_cfg["minority_ratios"]]
    methods = [str(m) for m in sweep_cfg["methods"]]
    targets = [float(t) for t in model_cfg["reporting"]["precision_targets"]]
    seed = int(model_cfg["cross_validation"]["cv_seed"])
    matrix = dataset.matrix(FEATURE_SET)

    rows: List[Dict[str, Any]] = []
    for fold in build_folds(dataset.keys, dataset.labels, gen_cfg, model_cfg):
        candidate = neutral_hyperparameters(dataset, fold, model_cfg, seed)
        train_x, train_y = matrix.iloc[fold.train_index], dataset.labels[fold.train_index]
        test_x, test_y = matrix.iloc[fold.test_index], dataset.labels[fold.test_index]
        fold_seed = derived_seed(seed, fold.repeat, fold.fold)
        natural_ratio = float((train_y == 1).sum() / max((train_y == 0).sum(), 1))
        for method in methods:
            # "none" is the untouched training split: no synthetic rows, no
            # weighting. It has one cell, at whatever ratio the data already has.
            cells = [natural_ratio] if method == "none" else ratios
            for ratio in cells:
                model = fit_xgboost(
                    train_x, train_y, candidate, method, model_cfg, fold_seed,
                    None if method == "none" else ratio,
                )
                scores = model.predict_proba(test_x)[:, 1]
                rows.append({
                    "method": method,
                    # "none" sits at whatever ratio each fold's data already has,
                    # so it is labelled rather than grouped by an exact value.
                    "ratio_label": "natural" if method == "none" else f"{ratio:g}",
                    "minority_ratio": round(ratio, 4),
                    "repeat": fold.repeat, "fold": fold.fold,
                    **fold_metrics(test_y, scores, targets),
                })
        print(f"repeat {fold.repeat} fold {fold.fold} swept")
    return pd.DataFrame(rows)


def summarise(table: pd.DataFrame, targets: List[float]) -> pd.DataFrame:
    columns = ["pr_auc", "roc_auc", *[f"recall_at_p{int(t * 100)}" for t in targets]]
    grouped = table.groupby(["method", "ratio_label"], sort=False)
    summary = pd.concat(
        [grouped[columns].mean().add_suffix("_mean"),
         grouped[columns].std(ddof=1).add_suffix("_sd"),
         grouped["minority_ratio"].mean().rename("mean_minority_ratio"),
         grouped.size().rename("n_folds")],
        axis=1,
    )
    return summary.reset_index().sort_values(["method", "mean_minority_ratio"])


def main() -> None:
    gen_cfg = config_module.load_config(config_module.GENERATOR_CONFIG)
    model_cfg = config_module.load_config(config_module.MODEL_CONFIG)
    data_module.check_provenance()
    dataset = data_module.load_dataset()
    targets = [float(t) for t in model_cfg["reporting"]["precision_targets"]]

    by_fold = sweep(dataset, gen_cfg, model_cfg)
    summary = summarise(by_fold, targets)
    by_fold.to_csv(OUTPUT_DIR / "resampling_sweep_by_fold.csv", index=False, float_format="%.6g")
    summary.to_csv(OUTPUT_DIR / "resampling_sweep_summary.csv", index=False, float_format="%.6g")

    pd.set_option("display.width", 250)
    print(summary.round(4).to_string(index=False))
    print()
    print("PR-AUC by method and ratio")
    print(summary.pivot(index="mean_minority_ratio", columns="method", values="pr_auc_mean").round(4).to_string())


if __name__ == "__main__":
    main()
