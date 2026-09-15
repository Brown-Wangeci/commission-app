"""Every reported number, computed from out-of-fold predictions and written to CSV.

Usage: python -m src.eval.results   (after python -m src.train.run)
"""

from __future__ import annotations

from typing import Any, Dict, List, Sequence, Tuple

import numpy as np
import pandas as pd

from ..generator import config as config_module
from ..generator.features import T7_FEATURES
from ..train import data as data_module
from ..train.models import rule_flags
from . import checks
from .metrics import fold_metrics, precision_key, typology_recall

OUTPUT_DIR = config_module.REPO_ROOT / "outputs"
PREDICTIONS_PATH = OUTPUT_DIR / "oof_predictions.parquet"

MODEL_LABELS = {
    "rules_t7": "Rules baseline (4 analyst rules, T7 time)",
    "logreg_t7": "Logistic regression, T7 feature set",
    "xgb_t7_smote": "XGBoost, T7 feature set, SMOTE",
    "xgb_t7_spw": "XGBoost, T7 feature set, scale_pos_weight",
    "xgb_t0_smote": "XGBoost, T0 feature set only, SMOTE",
    "xgb_t0_spw": "XGBoost, T0 feature set only, scale_pos_weight",
}

PAIRED_COMPARISONS = (
    ("xgb_t7_spw", "xgb_t7_smote", "T7: scale_pos_weight minus SMOTE"),
    ("xgb_t0_spw", "xgb_t0_smote", "T0: scale_pos_weight minus SMOTE"),
    ("xgb_t7_smote", "xgb_t0_smote", "SMOTE: T7 minus T0"),
    ("xgb_t7_spw", "xgb_t0_spw", "scale_pos_weight: T7 minus T0"),
)


def metric_names(targets: Sequence[float]) -> List[str]:
    return ["pr_auc", "roc_auc", *[precision_key(t) for t in targets]]


def load_predictions(dataset: data_module.Dataset) -> pd.DataFrame:
    lookup = pd.DataFrame(
        {
            "activation_id": dataset.keys["activation_id"],
            "label": dataset.labels,
            "typology": dataset.typology,
        }
    )
    return pd.read_parquet(PREDICTIONS_PATH).merge(lookup, on="activation_id", how="left")


def fold_table(predictions: pd.DataFrame, folds: pd.DataFrame, targets: Sequence[float]) -> pd.DataFrame:
    rows = []
    for (model, repeat, fold), group in predictions.groupby(["model", "repeat", "fold"], sort=False):
        labels = group["label"].to_numpy()
        scores = group["score"].to_numpy(dtype=float)
        rows.append({"model": model, "repeat": repeat, "fold": fold, **fold_metrics(labels, scores, targets)})
    table = pd.DataFrame(rows)
    agent_columns = ["repeat", "fold", "n_test_agents"] + [
        c for c in folds.columns if c.startswith("test_agents_")
    ]
    table = table.merge(folds[agent_columns], on=["repeat", "fold"], how="left")
    table["pr_auc_over_prevalence"] = table["pr_auc"] / table["prevalence"]
    return table


def summary_table(folds: pd.DataFrame, targets: Sequence[float]) -> pd.DataFrame:
    columns = ["prevalence", *metric_names(targets), "pr_auc_over_prevalence"]
    grouped = folds.groupby("model", sort=False)[columns]
    means = grouped.mean().add_suffix("_mean")
    sds = grouped.std(ddof=1).add_suffix("_sd")
    table = pd.concat([means, sds], axis=1)
    ordered = [f"{c}_{s}" for c in columns for s in ("mean", "sd")]
    table = table[ordered].reset_index()
    table.insert(1, "description", table["model"].map(MODEL_LABELS))
    table.insert(2, "n_folds", folds.groupby("model", sort=False).size().to_numpy())
    return table


def formatted_table(summary: pd.DataFrame, targets: Sequence[float]) -> pd.DataFrame:
    """Mean (sd) strings, ready to paste into the document."""
    out = summary[["model", "description", "n_folds"]].copy()
    for metric in ["prevalence", *metric_names(targets)]:
        out[metric] = [
            f"{m:.3f} ({s:.3f})" for m, s in zip(summary[f"{metric}_mean"], summary[f"{metric}_sd"])
        ]
    return out


def paired_differences(folds: pd.DataFrame, targets: Sequence[float]) -> Tuple[pd.DataFrame, pd.DataFrame]:
    """Same-fold differences between two models, per fold and summarised."""
    metrics = metric_names(targets)
    indexed = folds.set_index(["model", "repeat", "fold"])
    per_fold, summary = [], []
    for first, second, label in PAIRED_COMPARISONS:
        difference = indexed.loc[first, metrics] - indexed.loc[second, metrics]
        frame = difference.reset_index().assign(comparison=label)
        per_fold.append(frame)
        row: Dict[str, Any] = {"comparison": label, "n_folds": len(frame)}
        for metric in metrics:
            row[f"{metric}_diff_mean"] = float(frame[metric].mean())
            row[f"{metric}_diff_sd"] = float(frame[metric].std(ddof=1))
            row[f"{metric}_folds_first_better"] = int((frame[metric] > 0).sum())
        summary.append(row)
    return pd.concat(per_fold, ignore_index=True), pd.DataFrame(summary)


def typology_tables(predictions: pd.DataFrame, targets: Sequence[float]) -> Tuple[pd.DataFrame, pd.DataFrame]:
    rows = []
    for (model, repeat, fold), group in predictions.groupby(["model", "repeat", "fold"], sort=False):
        for row in typology_recall(
            group["label"].to_numpy(), group["score"].to_numpy(dtype=float),
            group["typology"].to_numpy(), targets,
        ):
            rows.append({"model": model, "repeat": repeat, "fold": fold, **row})
    per_fold = pd.DataFrame(rows)
    summary = (
        per_fold.groupby(["model", "precision_target", "typology"], sort=False)
        .agg(recall_mean=("recall", "mean"), recall_sd=("recall", lambda s: s.std(ddof=1)),
             n_positive_mean=("n_positive", "mean"), n_positive_min=("n_positive", "min"),
             n_folds=("recall", "size"))
        .reset_index()
    )
    return per_fold, summary


def rule_statistics(dataset: data_module.Dataset, predictions: pd.DataFrame, model_cfg: Dict[str, Any]) -> pd.DataFrame:
    """Each analyst rule on every test-period row once (repeat 0 covers each row exactly once)."""
    test_ids = predictions.loc[(predictions["model"] == "rules_t7") & (predictions["repeat"] == 0), "activation_id"]
    rows = dataset.keys["activation_id"].isin(set(test_ids)).to_numpy()
    flags = rule_flags(dataset.features.loc[rows], model_cfg["rules_baseline"])
    labels = dataset.labels[rows]
    out = []
    for rule in model_cfg["rules_baseline"]:
        fired = flags[rule["name"]].to_numpy()
        out.append({
            "rule": rule["name"],
            "description": rule["description"],
            "fired_share": float(fired.mean()),
            "precision": float(labels[fired].mean()) if fired.any() else np.nan,
            "recall": float(fired[labels == 1].mean()),
        })
    return pd.DataFrame(out)


def diagnostics_outputs(
    dataset: data_module.Dataset, folds: pd.DataFrame, gen_cfg: Dict[str, Any]
) -> Dict[str, pd.DataFrame]:
    logreg = folds[folds["model"] == "logreg_t7"]
    result = checks.run_diagnostics(dataset.features, dataset.labels, logreg)
    group = {name: ("T7" if name in T7_FEATURES else "T0") for name in dataset.features.columns}
    auc = checks.single_feature_auc(dataset.features, dataset.labels)
    correlation = checks.label_correlation(dataset.features, dataset.labels)
    t7 = dataset.features[list(T7_FEATURES)]
    return {
        "diagnostics": checks.diagnostics_table(result, gen_cfg),
        "single_feature_auc": pd.DataFrame(
            {"feature": auc.index, "group": [group[n] for n in auc.index], "auc": auc.to_numpy(),
             "label_correlation": correlation.reindex(auc.index).to_numpy()}
        ),
        "t7_correlation_pearson": checks.t7_correlation(t7, "pearson"),
        "t7_correlation_spearman": checks.t7_correlation(t7, "spearman"),
    }


def write_all(gen_cfg: Dict[str, Any], model_cfg: Dict[str, Any]) -> Dict[str, pd.DataFrame]:
    targets = [float(t) for t in model_cfg["reporting"]["precision_targets"]]
    dataset = data_module.load_dataset()
    predictions = load_predictions(dataset)
    folds = pd.read_csv(OUTPUT_DIR / "cv_folds.csv")

    per_fold = fold_table(predictions, folds, targets)
    summary = summary_table(per_fold, targets)
    paired_fold, paired_summary = paired_differences(per_fold, targets)
    typology_fold, typology_summary = typology_tables(predictions, targets)
    tables = {
        "cv_fold_metrics": per_fold,
        "cv_summary": summary,
        "results_table_formatted": formatted_table(summary, targets),
        "paired_differences_by_fold": paired_fold,
        "paired_differences_summary": paired_summary,
        "typology_recall_by_fold": typology_fold,
        "typology_recall_summary": typology_summary,
        "rules_baseline_rule_statistics": rule_statistics(dataset, predictions, model_cfg),
        **diagnostics_outputs(dataset, per_fold, gen_cfg),
    }
    for name, table in tables.items():
        keep_index = name.startswith("t7_correlation")
        table.to_csv(OUTPUT_DIR / f"{name}.csv", index=keep_index, float_format="%.6g")
    return tables


def main() -> None:
    gen_cfg = config_module.load_config(config_module.GENERATOR_CONFIG)
    model_cfg = config_module.load_config(config_module.MODEL_CONFIG)
    tables = write_all(gen_cfg, model_cfg)
    pd.set_option("display.width", 250)
    pd.set_option("display.max_columns", 30)
    print(tables["results_table_formatted"].to_string(index=False))


if __name__ == "__main__":
    main()
