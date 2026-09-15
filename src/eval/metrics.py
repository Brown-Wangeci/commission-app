"""Threshold-free and fixed-precision metrics. Accuracy is deliberately absent."""

from __future__ import annotations

from typing import Dict, Optional, Sequence

import numpy as np
from sklearn.metrics import average_precision_score, precision_recall_curve, roc_auc_score


def threshold_at_precision(
    labels: np.ndarray, scores: np.ndarray, target: float
) -> Optional[float]:
    """Highest-recall threshold whose precision reaches the target, or None if none does.

    This is the operating point that defines "recall at X% precision" on the
    fold itself. It is a metric definition, not a deployable decision threshold.
    """
    precision, recall, thresholds = precision_recall_curve(labels, scores)
    reachable = precision[:-1] >= target
    if not reachable.any():
        return None
    best = int(np.argmax(np.where(reachable, recall[:-1], -1.0)))
    return float(thresholds[best])


def recall_at_threshold(labels: np.ndarray, scores: np.ndarray, threshold: Optional[float]) -> float:
    positives = labels == 1
    if threshold is None or not positives.any():
        return 0.0
    return float((scores[positives] >= threshold).mean())


def precision_key(target: float) -> str:
    return f"recall_at_p{int(round(target * 100))}"


def fold_metrics(
    labels: np.ndarray, scores: np.ndarray, precision_targets: Sequence[float]
) -> Dict[str, float]:
    """Headline PR-AUC, secondary ROC-AUC, and recall at each precision target."""
    out = {
        "n_test": float(len(labels)),
        "n_positive": float(labels.sum()),
        "prevalence": float(labels.mean()),
        "pr_auc": float(average_precision_score(labels, scores)),
        "roc_auc": float(roc_auc_score(labels, scores)),
    }
    for target in precision_targets:
        threshold = threshold_at_precision(labels, scores, target)
        out[precision_key(target)] = recall_at_threshold(labels, scores, threshold)
    return out


def typology_recall(
    labels: np.ndarray,
    scores: np.ndarray,
    typologies: np.ndarray,
    precision_targets: Sequence[float],
) -> list[Dict[str, float | str]]:
    """Recall within each fraud typology at the fold's overall precision operating points."""
    rows = []
    for target in precision_targets:
        threshold = threshold_at_precision(labels, scores, target)
        for name in sorted(set(typologies[labels == 1])):
            members = (typologies == name) & (labels == 1)
            flagged = 0.0 if threshold is None else float((scores[members] >= threshold).mean())
            rows.append(
                {
                    "precision_target": target,
                    "typology": str(name),
                    "n_positive": float(members.sum()),
                    "recall": flagged,
                }
            )
    return rows
