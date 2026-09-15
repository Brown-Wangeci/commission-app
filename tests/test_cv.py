import numpy as np
import pandas as pd
import pytest

from src.eval.cv import build_folds, time_boundaries


@pytest.fixture(scope="module")
def fold_setup(generated, cfg, model_config):
    _, _, internal, features = generated
    keys = features.keys
    labels = (
        internal.labels.set_index("activation_id")
        .reindex(keys["activation_id"])["is_fraudulent"]
        .to_numpy()
        .astype(int)
    )
    folds = build_folds(keys, labels, cfg, model_config)
    return keys, labels, folds, time_boundaries(cfg, model_config)


def _agents(keys: pd.DataFrame, index: np.ndarray) -> set:
    return set(keys["agent_id"].to_numpy()[index])


def _observed_by(keys: pd.DataFrame, index: np.ndarray, embargo: pd.Timedelta) -> pd.Series:
    return keys["timestamp_submitted"].iloc[index].dt.normalize() + embargo


def test_fold_count_is_folds_times_repeats(fold_setup, model_config) -> None:
    _, _, folds, _ = fold_setup
    cv_cfg = model_config["cross_validation"]
    assert len(folds) == int(cv_cfg["n_folds"]) * int(cv_cfg["n_repeats"])


def test_test_agents_never_appear_in_training(fold_setup) -> None:
    keys, _, folds, _ = fold_setup
    for fold in folds:
        assert _agents(keys, fold.train_index).isdisjoint(_agents(keys, fold.test_index))


def test_no_fold_trains_on_the_future(fold_setup) -> None:
    """Training rows have closed their T7 window before the first test row is submitted."""
    keys, _, folds, bounds = fold_setup
    for fold in folds:
        assert _observed_by(keys, fold.train_index, bounds.embargo).max() <= bounds.test_start
        assert keys["timestamp_submitted"].iloc[fold.test_index].min() >= bounds.test_start


def test_inner_validation_is_grouped_and_time_ordered_inside_training(fold_setup) -> None:
    keys, _, folds, bounds = fold_setup
    for fold in folds:
        assert set(fold.inner_train_index) <= set(fold.train_index)
        assert set(fold.inner_val_index) <= set(fold.train_index)
        assert _agents(keys, fold.inner_train_index).isdisjoint(_agents(keys, fold.inner_val_index))
        assert (
            _observed_by(keys, fold.inner_train_index, bounds.embargo).max() <= bounds.inner_val_start
        )
        assert keys["timestamp_submitted"].iloc[fold.inner_val_index].min() >= bounds.inner_val_start
        assert set(fold.inner_val_index).isdisjoint(fold.test_index)


def test_every_test_period_agent_is_tested_once_per_repeat(fold_setup) -> None:
    keys, _, folds, bounds = fold_setup
    in_test_period = keys.loc[keys["timestamp_submitted"] >= bounds.test_start, "agent_id"]
    for repeat in {fold.repeat for fold in folds}:
        tested = [a for fold in folds if fold.repeat == repeat for a in _agents(keys, fold.test_index)]
        assert sorted(tested) == sorted(set(in_test_period))


def test_repeats_redraw_the_agent_grouping(fold_setup) -> None:
    keys, _, folds, _ = fold_setup
    first = {frozenset(_agents(keys, f.test_index)) for f in folds if f.repeat == 0}
    second = {frozenset(_agents(keys, f.test_index)) for f in folds if f.repeat == 1}
    assert first != second


def test_folds_are_reproducible(fold_setup, cfg, model_config) -> None:
    keys, labels, folds, _ = fold_setup
    again = build_folds(keys, labels, cfg, model_config)
    for a, b in zip(folds, again):
        assert np.array_equal(a.test_index, b.test_index)
        assert np.array_equal(a.inner_val_index, b.inner_val_index)
