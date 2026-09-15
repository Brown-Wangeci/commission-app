"""Small randomised hyperparameter search, scored on the inner validation fold only.

The outer test rows are never passed to anything in this module.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List

import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score

from ..generator import distributions as dist
from .models import fit_xgboost


@dataclass(frozen=True)
class SearchResult:
    best: Dict[str, float]
    best_inner_pr_auc: float
    scores: List[float]


def sample_candidates(
    space: Dict[str, Any], count: int, rng: np.random.Generator
) -> List[Dict[str, float]]:
    return [
        {name: dist.draw_one(spec, rng) for name, spec in space.items()} for _ in range(count)
    ]


def search_xgboost(
    inner_train: tuple[pd.DataFrame, np.ndarray],
    inner_val: tuple[pd.DataFrame, np.ndarray],
    candidates: List[Dict[str, float]],
    method: str,
    model_cfg: Dict[str, Any],
    seed: int,
) -> SearchResult:
    """Fit every candidate on inner training rows and keep the best inner validation PR-AUC."""
    train_x, train_y = inner_train
    val_x, val_y = inner_val
    scores = []
    for candidate in candidates:
        model = fit_xgboost(train_x, train_y, candidate, method, model_cfg, seed)
        scores.append(float(average_precision_score(val_y, model.predict_proba(val_x)[:, 1])))
    best = int(np.argmax(scores))
    return SearchResult(best=candidates[best], best_inner_pr_auc=scores[best], scores=scores)
