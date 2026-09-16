"""Checks run because a result needed explaining before it could be reported.

Usage: python -m src.eval.investigations   (after python -m src.train.run)

- permutation control: XGBoost trained on shuffled training labels must score
  near prevalence on the real test labels, or the pipeline leaks;
- acceptance latency tail: how much of each class and typology sits in the
  long-latency tail, since held payout-gaming jobs looked near-separable;
- false positive sources: which agents' legitimate activations are flagged at
  the fixed-precision operating points.

Honesty type and typology are read for evaluation breakdowns only.
"""

from __future__ import annotations

from typing import Any, Dict, List

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.metrics import average_precision_score

from ..generator import config as config_module
from ..train import data as data_module
from ..train.models import fit_xgboost
from ..train.search import sample_candidates
from .cv import build_folds, derived_seed
from .metrics import threshold_at_precision
from .results import OUTPUT_DIR, load_predictions

HOUR_SECONDS = 3600.0


def permutation_control(dataset: data_module.Dataset, model_cfg: Dict[str, Any], gen_cfg: Dict[str, Any]) -> pd.DataFrame:
    """First fold of each repeat: XGBoost on real labels, then on several label shuffles.

    Also scores an Isolation Forest fitted without labels, which shows how much
    of the class signal is plain outlyingness in feature space. That is what
    lets a model trained on shuffled labels occasionally rank above prevalence.
    """
    inv_cfg = model_cfg["investigations"]
    cv_seed = int(model_cfg["cross_validation"]["cv_seed"])
    folds = [f for f in build_folds(dataset.keys, dataset.labels, gen_cfg, model_cfg) if f.fold == 0]
    rows = []
    for fold in folds:
        rng = np.random.default_rng(derived_seed(cv_seed, fold.repeat, fold.fold, 2))
        candidate = sample_candidates(model_cfg["xgboost"]["search_space"], 1, rng)[0]
        test_y = dataset.labels[fold.test_index]
        base = {"repeat": fold.repeat, "fold": fold.fold, "test_prevalence": float(test_y.mean())}
        for feature_set in ("t0", "t7"):
            matrix = dataset.matrix(feature_set)
            train_x, test_x = matrix.iloc[fold.train_index], matrix.iloc[fold.test_index]
            for run in range(1 + int(inv_cfg["permutation_shuffles"])):
                train_y = dataset.labels[fold.train_index]
                if run:
                    train_y = rng.permutation(train_y)
                model = fit_xgboost(train_x, train_y, candidate, "scale_pos_weight", model_cfg, cv_seed)
                rows.append(base | {"feature_set": feature_set, "scorer": "xgboost_spw",
                                    "training_labels": f"shuffled_{run}" if run else "real",
                                    "pr_auc": float(average_precision_score(test_y, model.predict_proba(test_x)[:, 1]))})
            forest = IsolationForest(n_estimators=int(inv_cfg["isolation_forest_trees"]), random_state=cv_seed)
            outlyingness = -forest.fit(train_x).score_samples(test_x)
            rows.append(base | {"feature_set": feature_set, "scorer": "isolation_forest", "training_labels": "none",
                                "pr_auc": float(average_precision_score(test_y, outlyingness))})
    return pd.DataFrame(rows)


def acceptance_latency_tail(dataset: data_module.Dataset, cut_hours: List[float]) -> pd.DataFrame:
    hours = dataset.features["job_acceptance_latency_seconds"].to_numpy() / HOUR_SECONDS
    groups = {"legitimate": dataset.labels == 0}
    groups |= {name: dataset.typology == name for name in sorted(set(dataset.typology) - {"none"})}
    rows = []
    for cut in cut_hours:
        above = hours > cut
        row: Dict[str, Any] = {"latency_above_hours": cut, "rows_above": int(above.sum()),
                               "fraud_share_above": float(dataset.labels[above].mean()) if above.any() else np.nan}
        for name, members in groups.items():
            row[f"share_of_{name}_above"] = float(above[members].mean())
        rows.append(row)
    return pd.DataFrame(rows)


def false_positive_sources(dataset: data_module.Dataset, model: str, targets: List[float]) -> pd.DataFrame:
    predictions = load_predictions(dataset)
    predictions = predictions[predictions["model"] == model]
    honesty = pd.Series(dataset.honesty_type, index=dataset.keys["activation_id"])
    predictions = predictions.assign(honesty_type=predictions["activation_id"].map(honesty).to_numpy())
    rows = []
    for (repeat, fold), group in predictions.groupby(["repeat", "fold"]):
        labels = group["label"].to_numpy()
        scores = group["score"].to_numpy(dtype=float)
        legit = group[labels == 0]
        for target in targets:
            threshold = threshold_at_precision(labels, scores, target)
            if threshold is None:
                continue
            false_positives = group[(scores >= threshold) & (labels == 0)]
            for honesty_type in ("honest", "opportunistic", "systematic"):
                rows.append({
                    "model": model, "repeat": repeat, "fold": fold, "precision_target": target,
                    "honesty_type": honesty_type, "false_positives": int(len(false_positives)),
                    "share_of_false_positives": float((false_positives["honesty_type"] == honesty_type).mean())
                    if len(false_positives) else np.nan,
                    "share_of_legitimate_test_rows": float((legit["honesty_type"] == honesty_type).mean()),
                })
    per_fold = pd.DataFrame(rows)
    return (
        per_fold.groupby(["model", "precision_target", "honesty_type"])
        .agg(share_of_false_positives_mean=("share_of_false_positives", "mean"),
             share_of_false_positives_sd=("share_of_false_positives", lambda s: s.std(ddof=1)),
             share_of_legitimate_test_rows_mean=("share_of_legitimate_test_rows", "mean"),
             false_positives_mean=("false_positives", "mean"))
        .reset_index()
    )


def false_positive_rate_by_lookalike(
    dataset: data_module.Dataset, model: str, targets: List[float]
) -> pd.DataFrame:
    """Which honest working patterns get an honest agent's payout held?

    Restricted to legitimate activations by agents who never defraud, so this is
    the cost carried by people who have done nothing wrong. The situations are
    the configured legitimate lookalikes: the honest behaviours that resemble
    fraud by construction.
    """
    internal = pd.read_parquet(data_module.DATA_DIR / "internal_labels.parquet")
    internal = internal.set_index("activation_id").reindex(dataset.keys["activation_id"])
    flags = [column for column in internal.columns if column.startswith("flag_")]
    all_predictions = load_predictions(dataset)
    all_predictions = all_predictions[all_predictions["model"] == model]
    honest_legit = pd.Series(
        (dataset.honesty_type == "honest") & (dataset.labels == 0), index=dataset.keys["activation_id"]
    )
    predictions = all_predictions[all_predictions["activation_id"].map(honest_legit).to_numpy()]
    flag_lookup = internal[flags].set_index(dataset.keys["activation_id"])

    rows = []
    for (repeat, fold), group in predictions.groupby(["repeat", "fold"]):
        every = all_predictions[
            (all_predictions["repeat"] == repeat) & (all_predictions["fold"] == fold)
        ]
        for target in targets:
            threshold = threshold_at_precision(
                every["label"].to_numpy(), every["score"].to_numpy(dtype=float), target
            )
            if threshold is None:
                continue
            flagged = group["score"].to_numpy(dtype=float) >= threshold
            member_flags = flag_lookup.reindex(group["activation_id"])
            for flag in flags + ["any_situation", "no_situation"]:
                if flag == "any_situation":
                    members = member_flags.any(axis=1).to_numpy()
                elif flag == "no_situation":
                    members = ~member_flags.any(axis=1).to_numpy()
                else:
                    members = member_flags[flag].to_numpy().astype(bool)
                if members.sum() == 0:
                    continue
                rows.append({
                    "model": model, "repeat": repeat, "fold": fold, "precision_target": target,
                    "situation": flag.replace("flag_", ""),
                    "honest_legitimate_rows": int(members.sum()),
                    "false_positive_rate": float(flagged[members].mean()),
                })
    per_fold = pd.DataFrame(rows)
    return (
        per_fold.groupby(["model", "precision_target", "situation"])
        .agg(false_positive_rate_mean=("false_positive_rate", "mean"),
             false_positive_rate_sd=("false_positive_rate", lambda s: s.std(ddof=1)),
             honest_legitimate_rows_mean=("honest_legitimate_rows", "mean"))
        .reset_index()
        .sort_values(["precision_target", "false_positive_rate_mean"], ascending=[True, False])
    )


def main() -> None:
    gen_cfg = config_module.load_config(config_module.GENERATOR_CONFIG)
    model_cfg = config_module.load_config(config_module.MODEL_CONFIG)
    targets = [float(t) for t in model_cfg["reporting"]["precision_targets"]]
    dataset = data_module.load_dataset()
    tables = {
        "investigation_permutation_control": permutation_control(dataset, model_cfg, gen_cfg),
        "investigation_acceptance_latency_tail": acceptance_latency_tail(
            dataset, [float(h) for h in model_cfg["investigations"]["latency_tail_cut_hours"]]
        ),
        "investigation_false_positive_sources": pd.concat(
            [false_positive_sources(dataset, model, targets) for model in ("xgb_t7_smote", "xgb_t0_smote")],
            ignore_index=True,
        ),
        "investigation_false_positives_on_honest_agents": false_positive_rate_by_lookalike(
            dataset, f"xgb_t7_{model_cfg['investigations']['chosen_imbalance_method']}", targets
        ),
    }
    pd.set_option("display.width", 250)
    pd.set_option("display.max_columns", 30)
    for name, table in tables.items():
        table.to_csv(OUTPUT_DIR / f"{name}.csv", index=False, float_format="%.6g")
        print(name)
        print(table.round(4).to_string(index=False))
        print()


if __name__ == "__main__":
    main()
