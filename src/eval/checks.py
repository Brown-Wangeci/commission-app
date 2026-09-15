"""Generation checks and dataset diagnostics.

These describe the synthetic dataset: how separable each feature is on its
own, how the classes and typologies are composed, and how a plain logistic
regression scores. They are reported, never used to accept or reject a
dataset, and no generator parameter is tuned to move them.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List

import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, roc_auc_score

from ..train.models import fit_logistic_regression
from .cv import build_folds, time_boundaries


@dataclass(frozen=True)
class Diagnostics:
    max_single_feature_auc: float
    max_single_feature_name: str
    max_abs_correlation: float
    max_abs_correlation_name: str
    logreg_pr_auc_mean: float
    logreg_pr_auc_sd: float
    logreg_roc_auc_mean: float
    logreg_roc_auc_sd: float
    prevalence: float


def single_feature_auc(features: pd.DataFrame, labels: np.ndarray) -> pd.Series:
    """AUC of each feature used alone, oriented so that it never falls below 0.5."""
    scores = {}
    for name in features.columns:
        column = features[name].to_numpy(dtype=float)
        if np.all(column == column[0]):
            scores[name] = 0.5
            continue
        auc = roc_auc_score(labels, column)
        scores[name] = max(auc, 1.0 - auc)
    return pd.Series(scores).sort_values(ascending=False)


def label_correlation(features: pd.DataFrame, labels: np.ndarray) -> pd.Series:
    correlations = {
        name: float(np.corrcoef(features[name].to_numpy(dtype=float), labels)[0, 1])
        for name in features.columns
    }
    series = pd.Series(correlations)
    return series.reindex(series.abs().sort_values(ascending=False).index)


def cross_validated_logreg(
    features: pd.DataFrame,
    labels: np.ndarray,
    keys: pd.DataFrame,
    gen_cfg: Dict[str, Any],
    model_cfg: Dict[str, Any],
) -> pd.DataFrame:
    """Per-fold PR-AUC and ROC-AUC of plain logistic regression on the given features."""
    rows = []
    for fold in build_folds(keys, labels, gen_cfg, model_cfg):
        model = fit_logistic_regression(
            features.iloc[fold.train_index], labels[fold.train_index], model_cfg
        )
        predicted = model.predict_proba(features.iloc[fold.test_index])[:, 1]
        held_out = labels[fold.test_index]
        rows.append(
            {
                "repeat": fold.repeat,
                "fold": fold.fold,
                "prevalence": float(held_out.mean()),
                "pr_auc": float(average_precision_score(held_out, predicted)),
                "roc_auc": float(roc_auc_score(held_out, predicted)),
            }
        )
    return pd.DataFrame(rows)


def run_diagnostics(
    features: pd.DataFrame, labels: np.ndarray, logreg_folds: pd.DataFrame
) -> Diagnostics:
    aucs = single_feature_auc(features, labels)
    correlations = label_correlation(features, labels)
    return Diagnostics(
        max_single_feature_auc=float(aucs.iloc[0]),
        max_single_feature_name=str(aucs.index[0]),
        max_abs_correlation=float(correlations.abs().iloc[0]),
        max_abs_correlation_name=str(correlations.index[0]),
        logreg_pr_auc_mean=float(logreg_folds["pr_auc"].mean()),
        logreg_pr_auc_sd=float(logreg_folds["pr_auc"].std(ddof=1)),
        logreg_roc_auc_mean=float(logreg_folds["roc_auc"].mean()),
        logreg_roc_auc_sd=float(logreg_folds["roc_auc"].std(ddof=1)),
        prevalence=float(labels.mean()),
    )


def diagnostics_table(result: Diagnostics, gen_cfg: Dict[str, Any]) -> pd.DataFrame:
    """The three checks beside their reference levels. Reporting only."""
    reference = gen_cfg["diagnostics"]
    low, high = (float(v) for v in reference["logreg_pr_auc_reference_band"])
    rows = [
        {
            "check": "max single-feature AUC",
            "value": result.max_single_feature_auc,
            "sd_across_folds": np.nan,
            "detail": result.max_single_feature_name,
            "reference": f"<= {reference['single_feature_auc_reference']}",
            "inside_reference": result.max_single_feature_auc
            <= float(reference["single_feature_auc_reference"]),
        },
        {
            "check": "max absolute label correlation",
            "value": result.max_abs_correlation,
            "sd_across_folds": np.nan,
            "detail": result.max_abs_correlation_name,
            "reference": f"<= {reference['abs_label_correlation_reference']}",
            "inside_reference": result.max_abs_correlation
            <= float(reference["abs_label_correlation_reference"]),
        },
        {
            "check": "logistic regression PR-AUC (T0+T7 features, cross-validated)",
            "value": result.logreg_pr_auc_mean,
            "sd_across_folds": result.logreg_pr_auc_sd,
            "detail": f"dataset prevalence {result.prevalence:.4f}",
            "reference": f"[{low}, {high}]",
            "inside_reference": low <= result.logreg_pr_auc_mean <= high,
        },
    ]
    table = pd.DataFrame(rows)
    table["gates_anything"] = False
    return table


def t7_correlation(t7_features: pd.DataFrame, method: str) -> pd.DataFrame:
    return t7_features.corr(method=method)


def prevalence_floor(
    internal_labels: pd.DataFrame,
    submitted: pd.Series,
    gen_cfg: Dict[str, Any],
    model_cfg: Dict[str, Any],
) -> Dict[str, float]:
    """Lowest prevalence at which the rarest typology still meets the per-fold positive count.

    floor = min_positives * n_folds / (activations in test period * rarest typology share)
    """
    required = float(gen_cfg["prevalence"]["min_test_positives_per_typology_per_fold"])
    n_folds = int(model_cfg["cross_validation"]["n_folds"])
    in_test = (submitted >= time_boundaries(gen_cfg, model_cfg).test_start).to_numpy()
    fraud = internal_labels.loc[internal_labels["is_fraudulent"], "fraud_typology"]
    rarest_share = float(fraud.value_counts(normalize=True).min())
    test_rows = float(in_test.sum())
    realised = float(internal_labels["is_fraudulent"].mean())
    return {
        "realised_fraud_rate": realised,
        "test_period_activations": test_rows,
        "rarest_typology": str(fraud.value_counts().idxmin()),
        "rarest_typology_share_of_fraud": rarest_share,
        "implied_prevalence_floor": required * n_folds / (test_rows * rarest_share),
        "expected_rarest_positives_per_fold": realised * test_rows * rarest_share / n_folds,
    }


def typology_counts(internal_labels: pd.DataFrame) -> pd.DataFrame:
    counts = internal_labels["fraud_typology"].value_counts().rename("records")
    frame = counts.to_frame()
    frame["share_of_all_records"] = frame["records"] / len(internal_labels)
    return frame


def ambiguity_counts(internal_labels: pd.DataFrame) -> pd.DataFrame:
    """Records sitting in genuinely ambiguous territory, split by direction."""
    honest_lookalike = internal_labels["is_ambiguous"] & ~internal_labels["is_fraudulent"]
    careful_fraud = internal_labels["is_ambiguous"] & internal_labels["is_fraudulent"]
    total = len(internal_labels)
    rows: List[Dict[str, Any]] = [
        {
            "case": "legitimate records that look fraudulent",
            "records": int(honest_lookalike.sum()),
            "share_of_all_records": float(honest_lookalike.sum() / total),
        },
        {
            "case": "fraudulent records committed carefully",
            "records": int(careful_fraud.sum()),
            "share_of_all_records": float(careful_fraud.sum() / total),
        },
        {
            "case": "all ambiguous records",
            "records": int(internal_labels["is_ambiguous"].sum()),
            "share_of_all_records": float(internal_labels["is_ambiguous"].sum() / total),
        },
    ]
    return pd.DataFrame(rows)


def flag_counts(internal_labels: pd.DataFrame) -> pd.DataFrame:
    """How often each lookalike situation occurs, by class."""
    flags = [column for column in internal_labels.columns if column.startswith("flag_")]
    rows = []
    for flag in flags:
        legitimate = internal_labels.loc[~internal_labels["is_fraudulent"], flag]
        fraudulent = internal_labels.loc[internal_labels["is_fraudulent"], flag]
        rows.append(
            {
                "situation": flag.replace("flag_", ""),
                "legitimate_records": int(legitimate.sum()),
                "legitimate_share": float(legitimate.mean()),
                "fraudulent_records": int(fraudulent.sum()),
                "fraudulent_share": float(fraudulent.mean()),
            }
        )
    return pd.DataFrame(rows)
