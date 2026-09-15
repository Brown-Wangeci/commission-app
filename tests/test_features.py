from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from sklearn.metrics import roc_auc_score

from src.generator import features as features_module
from src.generator.features import T0_FEATURES, T7_FEATURES, build_features
from src.generator.schema import INTERNAL_COLUMNS, ObservableLog


def test_build_features_rejects_anything_but_an_observable_log(generated, cfg) -> None:
    _, observable, internal, _ = generated
    with pytest.raises(TypeError):
        build_features(internal, cfg)
    with pytest.raises(TypeError):
        build_features(observable.activations, cfg)


def test_feature_module_never_names_an_internal_variable() -> None:
    source = Path(features_module.__file__).read_text(encoding="utf-8")
    for name in INTERNAL_COLUMNS:
        assert name not in source, f"features.py references the internal variable {name}"


def test_column_groups_are_exactly_as_declared(generated) -> None:
    _, _, _, features = generated
    assert tuple(features.t0.columns) == T0_FEATURES
    assert tuple(features.t7.columns) == T7_FEATURES
    assert set(features.t0.columns).isdisjoint(features.t7.columns)


def test_output_carries_no_internal_columns(generated) -> None:
    _, _, _, features = generated
    assert not INTERNAL_COLUMNS.intersection(features.combined().columns)


def test_features_are_finite(generated) -> None:
    _, _, _, features = generated
    matrix = pd.concat([features.t0, features.t7], axis=1)
    assert np.isfinite(matrix.to_numpy(dtype=float)).all()


def test_feature_values_are_physically_sensible(generated, cfg) -> None:
    _, _, _, features = generated
    window = int(cfg["features"]["t7_window_days"])
    assert (features.t0["agent_activation_velocity_1h"] >= 1).all()
    assert (features.t0["distance_from_agent_home_km"] >= 0).all()
    assert (features.t0["sim_age_at_activation_days"] >= 0).all()
    assert (features.t0["days_to_payout_cutoff"] >= 0).all()
    assert features.t7["customer_active_days_7d"].between(0, window + 1).all()
    assert features.t7["days_to_first_customer_activity"].between(0, window + 1).all()


def test_t0_features_use_no_information_from_the_future(generated, cfg) -> None:
    """Recomputing T0 on a truncated log must not change the rows that remain."""
    _, observable, _, features = generated
    keep = len(observable.activations) // 2
    kept_ids = observable.activations["activation_id"].iloc[:keep]
    truncated = ObservableLog(
        activations=observable.activations.iloc[:keep].copy(),
        activity=observable.activity[observable.activity["activation_id"].isin(kept_ids)].copy(),
        agents=observable.agents,
        payout_calendar=observable.payout_calendar,
    )
    recomputed = build_features(truncated, cfg)
    pd.testing.assert_frame_equal(recomputed.t0, features.t0.iloc[:keep])


def _labels(internal, features) -> np.ndarray:
    return (
        internal.labels.set_index("activation_id")
        .reindex(features.keys["activation_id"])["is_fraudulent"]
        .to_numpy()
        .astype(int)
    )


def test_no_single_feature_is_a_perfect_separator(generated) -> None:
    """Structural rule from CLAUDE.md, not the diagnostic reference levels, which gate nothing."""
    _, _, internal, features = generated
    labels = _labels(internal, features)
    matrix = pd.concat([features.t0, features.t7], axis=1)
    for name in matrix.columns:
        column = matrix[name].to_numpy(dtype=float)
        if np.all(column == column[0]):
            continue
        auc = roc_auc_score(labels, column)
        assert max(auc, 1 - auc) < 1.0, f"{name} separates the classes perfectly"


def test_every_feature_value_range_overlaps_between_classes(generated) -> None:
    _, _, internal, features = generated
    labels = _labels(internal, features)
    matrix = pd.concat([features.t0, features.t7], axis=1)
    for name in matrix.columns:
        fraud = matrix.loc[labels == 1, name]
        legit = matrix.loc[labels == 0, name]
        assert fraud.min() <= legit.max() and legit.min() <= fraud.max(), name


def test_downstream_channels_are_correlated_but_not_collinear(generated) -> None:
    _, _, _, features = generated
    active = features.t7[features.t7["customer_active_days_7d"] > 0]
    channels = active[["transaction_count_7d", "topup_amount_total_7d", "usage_minutes_total_7d"]]
    correlation = channels.corr(method="spearman").to_numpy()
    off_diagonal = correlation[~np.eye(3, dtype=bool)]
    assert (off_diagonal > 0).all()
    assert (off_diagonal < 0.9).all()


def test_a_heavy_spender_can_transact_rarely(generated) -> None:
    _, _, _, features = generated
    t7 = features.t7[features.t7["customer_active_days_7d"] > 0]
    heavy_topup = t7["topup_amount_total_7d"] > t7["topup_amount_total_7d"].quantile(0.75)
    few_transactions = t7["transaction_count_7d"] <= t7["transaction_count_7d"].quantile(0.25)
    assert (heavy_topup & few_transactions).any()
