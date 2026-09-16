"""How much of a before-and-after difference is just a different random dataset?

Usage: python -m src.eval.realisation_control

Adding draws to the generator shifts every subsequent random number, so a fixed
generator change produces a different realisation, not the same dataset with one
column edited. This runs one fixed model over the first repeat's folds for
several seeds, so the spread across seeds measures realisation noise. Running
the same module against the pre-fix generator gives the matched comparison.

No hyperparameter search: the candidate is fixed in config, so the only thing
varying is the dataset.
"""

from __future__ import annotations

import copy
from typing import Any, Dict

import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score

from ..generator import config as config_module
from ..generator.run import generate
from ..train.models import fit_xgboost
from .cv import build_folds, derived_seed

OUTPUT_DIR = config_module.REPO_ROOT / "outputs"
FEATURE_SET_NOTE = "t7 (all T0 and T7 features)"


def _matrix(features) -> pd.DataFrame:
    return pd.concat([features.t0, features.t7], axis=1)


def run_seed(
    gen_cfg: Dict[str, Any], model_cfg: Dict[str, Any], seed: int, method: str
) -> list[Dict[str, Any]]:
    control = model_cfg["investigations"]["realisation_control"]
    candidate = {k: float(v) for k, v in control["candidate"].items()}
    single_repeat = copy.deepcopy(model_cfg)
    single_repeat["cross_validation"]["n_repeats"] = 1
    seeded = copy.deepcopy(gen_cfg)
    seeded["seed"] = seed

    _, internal, features, manifest = generate(write=False, cfg=seeded)
    labels_frame = internal.labels.set_index("activation_id").reindex(features.keys["activation_id"])
    labels = labels_frame["is_fraudulent"].to_numpy().astype(int)
    matrix = _matrix(features)
    cv_seed = int(model_cfg["cross_validation"]["cv_seed"])

    rows = []
    for fold in build_folds(features.keys, labels, seeded, single_repeat):
        model = fit_xgboost(
            matrix.iloc[fold.train_index], labels[fold.train_index], candidate, method,
            model_cfg, derived_seed(cv_seed, fold.repeat, fold.fold),
        )
        scores = model.predict_proba(matrix.iloc[fold.test_index])[:, 1]
        test_labels = labels[fold.test_index]
        rows.append({
            "seed": seed,
            "fold": fold.fold,
            "dataset_fraud_rate": manifest["summary"]["realised_fraud_rate"],
            "test_prevalence": float(test_labels.mean()),
            "pr_auc": float(average_precision_score(test_labels, scores)),
        })
    return rows


def main() -> None:
    gen_cfg = config_module.load_config(config_module.GENERATOR_CONFIG)
    model_cfg = config_module.load_config(config_module.MODEL_CONFIG)
    control = model_cfg["investigations"]["realisation_control"]
    method = str(model_cfg["investigations"]["chosen_imbalance_method"])
    rows = []
    for seed in [int(s) for s in control["seeds"]]:
        rows.extend(run_seed(gen_cfg, model_cfg, seed, method))
        print(f"seed {seed} done")
    table = pd.DataFrame(rows)
    label = str(control["label"])
    table.insert(0, "generator_version", label)
    table.to_csv(OUTPUT_DIR / f"realisation_control_{label}.csv", index=False, float_format="%.6g")
    pd.set_option("display.width", 200)
    print(table.round(4).to_string(index=False))
    print()
    print("per seed mean PR-AUC")
    print(table.groupby("seed")["pr_auc"].agg(["mean", "std"]).round(4).to_string())
    print(f"across all folds and seeds: mean {table['pr_auc'].mean():.4f}, sd {table['pr_auc'].std(ddof=1):.4f}")


if __name__ == "__main__":
    main()
