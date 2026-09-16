"""Train the single deployable model artifact.

This is not a Phase 5/6 evaluation run and adds no new evidence: it produces
ONE model, fitted on the full dataset currently on disk (data/), using the
same procedure validated in Phase 5/6 -- agent-grouped fit/calibration split,
the same random hyperparameter search, the chosen feature set and imbalance
method (no resampling), isotonic calibration.

The one deliberate difference from a CV fold is that there is no outer
time-ordered test period: Phase 5/6 already measured out-of-fold performance
across four seeds and this module changes no parameter that would invalidate
those numbers, so production training uses every row instead of holding a
test slice back. This is stated plainly in the model card.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict

import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression

from ..eval.cv import _agent_groups, derived_seed  # noqa: SLF001 -- reused deliberately, see module docstring
from ..generator import config as config_module
from . import data as data_module
from .models import fit_xgboost
from .search import sample_candidates, search_xgboost

# Distinct from any (repeat, fold) pair build_folds ever produces (repeats are
# 0-2, folds 0-4), so the production split's derived seeds cannot collide with
# a CV fold's, even though both are ultimately seeded from the same cv_seed.
PRODUCTION_SEED_MARKER = 1_000_000


@dataclass(frozen=True)
class ProductionModel:
    """Everything needed to serialise a deployable artifact."""

    booster: Any
    calibrator: IsotonicRegression
    feature_set: str
    features: tuple
    method: str
    hyperparameters: Dict[str, float]
    inner_val_pr_auc: float
    n_fit_rows: int
    n_calibration_rows: int
    n_total_rows: int
    training_seed: int
    generator_config_hash: str
    model_config_hash: str
    dataset_provenance: Dict[str, Any]


def _agent_split(
    keys: pd.DataFrame, labels: np.ndarray, index: np.ndarray, fraction: float, seed: int
) -> tuple[np.ndarray, np.ndarray]:
    """Split `index` by whole agent, the same grouping cv.py uses everywhere else."""
    agents = keys["agent_id"].to_numpy()[index]
    splits = int(round(1.0 / fraction))
    held_agents = _agent_groups(agents, labels[index], splits, seed)[0]
    is_held = np.isin(agents, held_agents)
    return index[~is_held], index[is_held]


def train_production_model(
    gen_cfg: Dict[str, Any], model_cfg: Dict[str, Any]
) -> ProductionModel:
    """Fit and calibrate the chosen model on the full dataset on disk."""
    dataset_manifest = data_module.check_provenance()
    dataset = data_module.load_dataset()

    chosen_name = str(model_cfg["multi_seed"]["chosen_model"])
    spec = next(s for s in model_cfg["multi_seed"]["models"] if s["name"] == chosen_name)
    feature_set, method = str(spec["feature_set"]), str(spec["method"])
    matrix = dataset.matrix(feature_set)
    labels = dataset.labels
    keys = dataset.keys
    cv_cfg = model_cfg["cross_validation"]
    xgb_cfg = model_cfg["xgboost"]
    base_seed = int(cv_cfg["cv_seed"])

    all_rows = np.arange(len(keys))
    fit_index, calibration_index = _agent_split(
        keys, labels, all_rows, float(cv_cfg["calibration_agent_fraction"]),
        derived_seed(base_seed, PRODUCTION_SEED_MARKER, 3),
    )
    inner_train, inner_val = _agent_split(
        keys, labels, fit_index, float(cv_cfg["inner_validation_agent_fraction"]),
        derived_seed(base_seed, PRODUCTION_SEED_MARKER, 1),
    )

    fit_seed = derived_seed(base_seed, PRODUCTION_SEED_MARKER)
    rng = np.random.default_rng(derived_seed(base_seed, PRODUCTION_SEED_MARKER, 2))
    candidates = sample_candidates(xgb_cfg["search_space"], int(xgb_cfg["search_iterations"]), rng)
    search = search_xgboost(
        (matrix.iloc[inner_train], labels[inner_train]),
        (matrix.iloc[inner_val], labels[inner_val]),
        candidates, method, model_cfg, fit_seed,
    )

    booster = fit_xgboost(
        matrix.iloc[fit_index], labels[fit_index], search.best, method, model_cfg, fit_seed
    )
    calibration_scores = booster.predict_proba(matrix.iloc[calibration_index])[:, 1]
    calibrator = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
    calibrator.fit(calibration_scores, labels[calibration_index])

    return ProductionModel(
        booster=booster,
        calibrator=calibrator,
        feature_set=feature_set,
        features=tuple(matrix.columns),
        method=method,
        hyperparameters=dict(search.best),
        inner_val_pr_auc=float(search.best_inner_pr_auc),
        n_fit_rows=int(len(fit_index)),
        n_calibration_rows=int(len(calibration_index)),
        n_total_rows=int(len(keys)),
        training_seed=fit_seed,
        generator_config_hash=str(dataset_manifest["generator_config_hash"]),
        model_config_hash=config_module.config_hash([config_module.MODEL_CONFIG]),
        dataset_provenance={
            "generated_at": dataset_manifest.get("generated_at"),
            "seed": dataset_manifest.get("seed"),
            "num_activations": dataset_manifest.get("summary", {}).get("num_activations"),
            "realised_fraud_rate": dataset_manifest.get("summary", {}).get("realised_fraud_rate"),
        },
    )
