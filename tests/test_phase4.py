import numpy as np
import pandas as pd
import pytest

from src.eval.lookalike_audit import audit
from src.train import data as data_module
from src.train.data import AGENT_HISTORY_FEATURES, FEATURE_SETS
from src.train.models import binary_columns, fit_xgboost, smote_resample


@pytest.fixture
def imbalanced_frame() -> tuple[pd.DataFrame, np.ndarray]:
    rng = np.random.default_rng(0)
    size = 600
    features = pd.DataFrame({
        "continuous": rng.normal(size=size),
        "also_continuous": rng.gamma(2.0, 1.0, size=size),
        "binary_flag": (rng.random(size) < 0.3).astype(float),
    })
    labels = (rng.random(size) < 0.08).astype(int)
    labels[:20] = 1
    return features, labels


def test_scale_pos_weight_matches_the_requested_minority_ratio(imbalanced_frame, model_config) -> None:
    features, labels = imbalanced_frame
    imbalance = (labels == 0).sum() / (labels == 1).sum()
    for ratio in (0.1, 0.5, 1.0):
        model = fit_xgboost(features, labels, {"n_estimators": 10, "max_depth": 2},
                            "scale_pos_weight", model_config, 0, ratio)
        assert model.get_params()["scale_pos_weight"] == pytest.approx(ratio * imbalance)


def test_scale_pos_weight_without_a_ratio_keeps_full_balance(imbalanced_frame, model_config) -> None:
    features, labels = imbalanced_frame
    model = fit_xgboost(features, labels, {"n_estimators": 10, "max_depth": 2},
                        "scale_pos_weight", model_config, 0)
    assert model.get_params()["scale_pos_weight"] == pytest.approx((labels == 0).sum() / (labels == 1).sum())


def test_oversampling_reaches_the_requested_ratio(imbalanced_frame, model_config) -> None:
    features, labels = imbalanced_frame
    for method_is_categorical in (False, True):
        resampled, resampled_labels = smote_resample(
            features, labels, model_config, 0, ratio=0.5, categorical=method_is_categorical
        )
        minority = (resampled_labels == 1).sum()
        majority = (resampled_labels == 0).sum()
        assert minority / majority == pytest.approx(0.5, rel=0.02)


def test_smotenc_keeps_binary_columns_binary_and_smote_does_not(imbalanced_frame, model_config) -> None:
    features, labels = imbalanced_frame
    assert binary_columns(features) == [2]
    plain, _ = smote_resample(features, labels, model_config, 0, ratio=0.5, categorical=False)
    categorical, _ = smote_resample(features, labels, model_config, 0, ratio=0.5, categorical=True)
    assert set(np.unique(categorical["binary_flag"])) <= {0.0, 1.0}
    assert not set(np.unique(plain["binary_flag"])) <= {0.0, 1.0}


def test_ablation_feature_set_drops_only_agent_history() -> None:
    full = set(FEATURE_SETS["t7"])
    ablated = set(FEATURE_SETS["t7_no_agent_history"])
    assert full - ablated == set(AGENT_HISTORY_FEATURES)
    assert ablated < full


def test_audit_flags_a_separator_and_spares_an_overlapping_feature(model_config) -> None:
    rng = np.random.default_rng(1)
    size = 4000
    labels = (rng.random(size) < 0.1).astype(int)
    typology = np.where(labels == 1, "ghost", "none")
    separator = np.where(labels == 1, rng.normal(50, 1, size), rng.normal(0, 1, size))
    overlapping = np.where(labels == 1, rng.normal(0.4, 1, size), rng.normal(0, 1, size))
    dataset = data_module.Dataset(
        keys=pd.DataFrame({"activation_id": np.arange(size).astype(str),
                           "agent_id": "a", "timestamp_submitted": pd.Timestamp("2025-01-06")}),
        features=pd.DataFrame({"separator": separator, "overlapping": overlapping}),
        labels=labels, typology=typology, honesty_type=np.full(size, "opportunistic"),
    )
    table = audit(dataset, model_config).set_index("feature")
    assert bool(table.loc["separator", "flagged_no_counterpart"])
    assert not bool(table.loc["overlapping", "flagged_no_counterpart"])
