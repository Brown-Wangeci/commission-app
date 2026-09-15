import numpy as np
import pytest

from src.eval.metrics import fold_metrics, threshold_at_precision, typology_recall

LABELS = np.array([1, 1, 0, 1, 0, 0])
SCORES = np.array([0.9, 0.8, 0.7, 0.6, 0.5, 0.4])


def test_recall_at_precision_takes_the_highest_recall_meeting_the_target() -> None:
    metrics = fold_metrics(LABELS, SCORES, [0.9, 0.75])
    assert metrics["recall_at_p90"] == pytest.approx(2 / 3)
    assert metrics["recall_at_p75"] == pytest.approx(1.0)


def test_unreachable_precision_gives_zero_recall() -> None:
    labels = np.array([0, 1, 0, 1])
    scores = np.array([0.9, 0.8, 0.7, 0.6])
    assert threshold_at_precision(labels, scores, 0.9) is None
    assert fold_metrics(labels, scores, [0.9])["recall_at_p90"] == 0.0


def test_prevalence_is_reported_with_the_scores() -> None:
    metrics = fold_metrics(LABELS, SCORES, [0.9])
    assert metrics["prevalence"] == pytest.approx(0.5)
    assert "accuracy" not in metrics


def test_typology_recall_uses_the_overall_operating_point() -> None:
    typologies = np.array(["ghost", "collusion", "none", "ghost", "none", "none"])
    rows = typology_recall(LABELS, SCORES, typologies, [0.9])
    by_name = {row["typology"]: row["recall"] for row in rows}
    assert by_name == {"collusion": 1.0, "ghost": 0.5}
