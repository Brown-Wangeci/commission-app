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
from imblearn.over_sampling import SMOTE
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline, make_pipeline
from sklearn.preprocessing import StandardScaler
from xgboost import XGBClassifier

IMBALANCE_METHODS = ("smote", "scale_pos_weight")
INTEGER_PARAMS = ("n_estimators", "max_depth")

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


def smote_resample(
    features: pd.DataFrame, labels: np.ndarray, model_cfg: Dict[str, Any], seed: int
) -> tuple[pd.DataFrame, np.ndarray]:
    """Oversample the minority class of a training split. Never called on held-out rows."""
    resampling = model_cfg["resampling"]
    sampler = SMOTE(
        sampling_strategy=float(resampling["target_minority_ratio"]),
        k_neighbors=int(resampling["smote_k_neighbors"]),
        random_state=seed,
    )
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
) -> XGBClassifier:
    """Fit on one training split, handling imbalance by SMOTE or by scale_pos_weight."""
    if method not in IMBALANCE_METHODS:
        raise ValueError(f"unknown imbalance method {method}")
    xgb_cfg = model_cfg["xgboost"]
    scale_pos_weight = 1.0
    if method == "smote":
        features, labels = smote_resample(features, labels, model_cfg, seed)
    else:
        scale_pos_weight = float((labels == 0).sum() / max((labels == 1).sum(), 1))
    model = XGBClassifier(
        **xgboost_params(candidate),
        scale_pos_weight=scale_pos_weight,
        tree_method=str(xgb_cfg["tree_method"]),
        n_jobs=int(xgb_cfg["n_jobs"]),
        random_state=seed,
    )
    model.fit(features, labels)
    return model
