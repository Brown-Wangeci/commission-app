"""Repeated cross-validation, grouped by agent and ordered by time.

Never a random row split. In every fold:

- test agents and training agents are disjoint;
- every test row is submitted on or after the test start date;
- every training row's downstream window has closed before the test start,
  so no training row carries T7 features or a label observed in the test
  period (the embargo is the T7 window, read from generator config);
- the inner validation fold used for hyperparameter search obeys the same
  three rules inside the outer training data.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List

import numpy as np
import pandas as pd
from sklearn.model_selection import StratifiedGroupKFold


@dataclass(frozen=True)
class Fold:
    repeat: int
    fold: int
    train_index: np.ndarray
    test_index: np.ndarray
    inner_train_index: np.ndarray
    inner_val_index: np.ndarray


@dataclass(frozen=True)
class TimeBoundaries:
    test_start: pd.Timestamp
    inner_val_start: pd.Timestamp
    embargo: pd.Timedelta


def time_boundaries(gen_cfg: Dict[str, Any], model_cfg: Dict[str, Any]) -> TimeBoundaries:
    """Test start, inner validation start and embargo, all on whole-day boundaries."""
    cv_cfg = model_cfg["cross_validation"]
    start = pd.Timestamp(gen_cfg["simulation"]["start_date"])
    num_days = int(gen_cfg["simulation"]["num_days"])
    embargo_days = int(gen_cfg["features"]["t7_window_days"]) + 1
    test_day = int(np.floor(num_days * float(cv_cfg["test_start_fraction"])))
    usable_train_days = test_day - embargo_days
    inner_day = int(np.floor(usable_train_days * float(cv_cfg["inner_validation_start_fraction"])))
    return TimeBoundaries(
        test_start=start + pd.Timedelta(days=test_day),
        inner_val_start=start + pd.Timedelta(days=inner_day),
        embargo=pd.Timedelta(days=embargo_days),
    )


def derived_seed(base_seed: int, *parts: int) -> int:
    """Independent, reproducible seed for one (repeat, fold, ...) position."""
    return int(np.random.SeedSequence([base_seed, *parts]).generate_state(1)[0])


def _observed_by(timestamps: pd.Series, embargo: pd.Timedelta) -> np.ndarray:
    """Moment a row's full downstream window has been observed."""
    return (timestamps.dt.normalize() + embargo).to_numpy()


def _agent_groups(
    agents: np.ndarray, labels: np.ndarray, n_splits: int, seed: int
) -> List[np.ndarray]:
    """Agent ids per group, balancing fraud across groups without splitting any agent."""
    splitter = StratifiedGroupKFold(n_splits=n_splits, shuffle=True, random_state=seed)
    placeholder = np.zeros(len(agents))
    return [np.unique(agents[test]) for _, test in splitter.split(placeholder, labels, agents)]


def _inner_split(
    keys: pd.DataFrame,
    labels: np.ndarray,
    train_index: np.ndarray,
    bounds: TimeBoundaries,
    cv_cfg: Dict[str, Any],
    seed: int,
) -> tuple[np.ndarray, np.ndarray]:
    agents = keys["agent_id"].to_numpy()[train_index]
    inner_splits = int(round(1.0 / float(cv_cfg["inner_validation_agent_fraction"])))
    val_agents = _agent_groups(agents, labels[train_index], inner_splits, seed)[0]
    is_val_agent = np.isin(agents, val_agents)

    stamps = keys["timestamp_submitted"].iloc[train_index]
    observed = _observed_by(stamps, bounds.embargo)
    submitted = stamps.to_numpy()
    inner_train = train_index[~is_val_agent & (observed <= bounds.inner_val_start.to_datetime64())]
    inner_val = train_index[is_val_agent & (submitted >= bounds.inner_val_start.to_datetime64())]
    return inner_train, inner_val


def build_folds(
    keys: pd.DataFrame,
    labels: np.ndarray,
    gen_cfg: Dict[str, Any],
    model_cfg: Dict[str, Any],
) -> List[Fold]:
    """Every (repeat, fold) pair with its outer and inner indices."""
    cv_cfg = model_cfg["cross_validation"]
    n_folds = int(cv_cfg["n_folds"])
    base_seed = int(cv_cfg["cv_seed"])
    bounds = time_boundaries(gen_cfg, model_cfg)

    agents = keys["agent_id"].to_numpy()
    submitted = keys["timestamp_submitted"].to_numpy()
    observed = _observed_by(keys["timestamp_submitted"], bounds.embargo)
    in_test_period = submitted >= bounds.test_start.to_datetime64()
    in_train_period = observed <= bounds.test_start.to_datetime64()

    folds: List[Fold] = []
    for repeat in range(int(cv_cfg["n_repeats"])):
        groups = _agent_groups(agents, labels, n_folds, derived_seed(base_seed, repeat))
        for fold, test_agents in enumerate(groups):
            is_test_agent = np.isin(agents, test_agents)
            train_index = np.where(~is_test_agent & in_train_period)[0]
            test_index = np.where(is_test_agent & in_test_period)[0]
            inner_train, inner_val = _inner_split(
                keys, labels, train_index, bounds, cv_cfg, derived_seed(base_seed, repeat, fold)
            )
            folds.append(
                Fold(repeat, fold, train_index, test_index, inner_train, inner_val)
            )
    return folds
