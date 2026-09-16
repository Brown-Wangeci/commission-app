"""The four model families: analyst rules, logistic regression, and XGBoost.

Every fit function receives only the rows of the split it is fitting. SMOTE
is called from inside fit_xgboost on those rows, so resampling can never touch
a validation or test row.
"""

from __future__ import annotations

import operator
from typing import Any, Callable, Dict, List

import numpy as np
import pandas as pd
from imblearn.over_sampling import SMOTE, SMOTENC
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline, make_pipeline
from sklearn.preprocessing import StandardScaler
from xgboost import XGBClassifier

IMBALANCE_METHODS = ("smote", "smotenc", "scale_pos_weight", "none")
INTEGER_PARAMS = ("n_estimators", "max_depth")
OVERSAMPLERS = ("smote", "smotenc")

_OPERATORS: Dict[str, Callable[[Any, Any], Any]] = {
    ">=": operator.ge,
    "<=": operator.le,
    ">": operator.gt,
    "<": operator.lt,
    "==": operator.eq,
}


def rule_flags(features: pd.DataFrame, rules: List[Dict[str, Any]]) -> pd.DataFrame:
    """One boolean column per rule: True where every condition of the rule holds."""
    flags = {}
    for rule in rules:
        fired = np.ones(len(features), dtype=bool)
        for condition in rule["conditions"]:
            compare = _OPERATORS[condition["op"]]
            column = features[condition["feature"]].to_numpy(dtype=float)
            fired &= compare(column, float(condition["value"]))
        flags[rule["name"]] = fired
    return pd.DataFrame(flags, index=features.index)


def rule_scores(features: pd.DataFrame, rules: List[Dict[str, Any]]) -> np.ndarray:
    """Number of rules triggered. No fitting of any kind."""
    return rule_flags(features, rules).sum(axis=1).to_numpy(dtype=float)


def fit_logistic_regression(
    features: pd.DataFrame, labels: np.ndarray, model_cfg: Dict[str, Any]
) -> Pipeline:
    lr_cfg = model_cfg["logistic_regression"]
    model = make_pipeline(
        StandardScaler(),
        LogisticRegression(C=float(lr_cfg["C"]), max_iter=int(lr_cfg["max_iter"])),
    )
    model.fit(features, labels)
    return model


def binary_columns(features: pd.DataFrame) -> list[int]:
    """Positions of columns holding only two distinct values, for SMOTE-NC."""
    return [
        position
        for position, name in enumerate(features.columns)
        if features[name].nunique(dropna=False) <= 2
    ]


def smote_resample(
    features: pd.DataFrame,
    labels: np.ndarray,
    model_cfg: Dict[str, Any],
    seed: int,
    ratio: float | None = None,
    categorical: bool = False,
) -> tuple[pd.DataFrame, np.ndarray]:
    """Oversample the minority class of a training split. Never called on held-out rows.

    With categorical=True this uses SMOTE-NC, which copies a binary column from
    the neighbourhood majority instead of interpolating it to a fraction.
    """
    resampling = model_cfg["resampling"]
    strategy = float(resampling["target_minority_ratio"] if ratio is None else ratio)
    neighbours = int(resampling["smote_k_neighbors"])
    if categorical:
        sampler = SMOTENC(
            categorical_features=binary_columns(features),
            sampling_strategy=strategy,
            k_neighbors=neighbours,
            random_state=seed,
        )
    else:
        sampler = SMOTE(sampling_strategy=strategy, k_neighbors=neighbours, random_state=seed)
    resampled, resampled_labels = sampler.fit_resample(features, labels)
    return resampled, np.asarray(resampled_labels)


def xgboost_params(candidate: Dict[str, float]) -> Dict[str, Any]:
    return {
        name: int(value) if name in INTEGER_PARAMS else float(value)
        for name, value in candidate.items()
    }


def fit_xgboost(
    features: pd.DataFrame,
    labels: np.ndarray,
    candidate: Dict[str, float],
    method: str,
    model_cfg: Dict[str, Any],
    seed: int,
    ratio: float | None = None,
) -> XGBClassifier:
    """Fit on one training split, handling imbalance by oversampling or by weighting.

    `ratio` is the effective minority-to-majority ratio after handling, so the
    methods can be compared at matched strength: an oversampler reaches it by
    generating rows, scale_pos_weight by weighting the rows that exist. Left
    as None, each method keeps its Phase 3 default (oversample to the configured
    ratio; weight to full balance).
    """
    if method not in IMBALANCE_METHODS:
        raise ValueError(f"unknown imbalance method {method}")
    xgb_cfg = model_cfg["xgboost"]
    scale_pos_weight = 1.0
    if method in OVERSAMPLERS:
        features, labels = smote_resample(
            features, labels, model_cfg, seed, ratio, categorical=method == "smotenc"
        )
    elif method == "scale_pos_weight":
        imbalance = float((labels == 0).sum() / max((labels == 1).sum(), 1))
        scale_pos_weight = imbalance if ratio is None else float(ratio) * imbalance
    model = XGBClassifier(
        **xgboost_params(candidate),
        scale_pos_weight=scale_pos_weight,
        tree_method=str(xgb_cfg["tree_method"]),
        n_jobs=int(xgb_cfg["n_jobs"]),
        random_state=seed,
    )
    model.fit(features, labels)
    return model
