"""Cross-validated training run.

Usage: python -m src.train.run

Runs every model on every (repeat, fold) of the grouped, time-ordered
cross-validation, writes out-of-fold test scores and a training manifest, then
computes every reported number with src.eval.results.
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from ..eval import results
from ..eval.cv import Fold, build_folds, derived_seed, time_boundaries
from ..generator import config as config_module
from . import data as data_module
from .models import fit_logistic_regression, fit_xgboost, rule_scores
from .search import sample_candidates, search_xgboost

OUTPUT_DIR = config_module.REPO_ROOT / "outputs"
PREDICTIONS_PATH = OUTPUT_DIR / "oof_predictions.parquet"


@dataclass(frozen=True)
class ModelSpec:
    name: str
    family: str
    feature_set: str
    method: Optional[str] = None


MODEL_SPECS = (
    ModelSpec("rules_t7", "rules", "t7"),
    ModelSpec("logreg_t7", "logreg", "t7"),
    ModelSpec("xgb_t7_smote", "xgboost", "t7", "smote"),
    ModelSpec("xgb_t7_spw", "xgboost", "t7", "scale_pos_weight"),
    ModelSpec("xgb_t0_smote", "xgboost", "t0", "smote"),
    ModelSpec("xgb_t0_spw", "xgboost", "t0", "scale_pos_weight"),
)


@dataclass
class RunRecords:
    predictions: List[pd.DataFrame]
    folds: List[Dict[str, Any]]
    params: List[Dict[str, Any]]
    importance: List[pd.DataFrame]


def _rows(dataset: data_module.Dataset, feature_set: str, index: np.ndarray):
    return dataset.matrix(feature_set).iloc[index], dataset.labels[index]


def _score_xgboost(
    spec: ModelSpec,
    dataset: data_module.Dataset,
    fold: Fold,
    candidates: List[Dict[str, float]],
    model_cfg: Dict[str, Any],
    records: RunRecords,
) -> np.ndarray:
    seed = derived_seed(int(model_cfg["cross_validation"]["cv_seed"]), fold.repeat, fold.fold)
    search = search_xgboost(
        _rows(dataset, spec.feature_set, fold.inner_train_index),
        _rows(dataset, spec.feature_set, fold.inner_val_index),
        candidates,
        spec.method,
        model_cfg,
        seed,
    )
    train_x, train_y = _rows(dataset, spec.feature_set, fold.train_index)
    model = fit_xgboost(train_x, train_y, search.best, spec.method, model_cfg, seed)
    records.params.append(
        {"repeat": fold.repeat, "fold": fold.fold, "model": spec.name,
         "inner_val_pr_auc": search.best_inner_pr_auc, **search.best}
    )
    gain = model.get_booster().get_score(importance_type="gain")
    records.importance.append(
        pd.DataFrame({"repeat": fold.repeat, "fold": fold.fold, "model": spec.name,
                      "feature": list(train_x.columns),
                      "gain": [gain.get(name, 0.0) for name in train_x.columns]})
    )
    test_x, _ = _rows(dataset, spec.feature_set, fold.test_index)
    return model.predict_proba(test_x)[:, 1]


def _score(
    spec: ModelSpec,
    dataset: data_module.Dataset,
    fold: Fold,
    candidates: List[Dict[str, float]],
    model_cfg: Dict[str, Any],
    records: RunRecords,
) -> np.ndarray:
    test_x, _ = _rows(dataset, spec.feature_set, fold.test_index)
    if spec.family == "rules":
        return rule_scores(test_x, model_cfg["rules_baseline"])
    if spec.family == "logreg":
        train_x, train_y = _rows(dataset, spec.feature_set, fold.train_index)
        return fit_logistic_regression(train_x, train_y, model_cfg).predict_proba(test_x)[:, 1]
    return _score_xgboost(spec, dataset, fold, candidates, model_cfg, records)


def _fold_record(dataset: data_module.Dataset, fold: Fold) -> Dict[str, Any]:
    test_agents = pd.Series(dataset.honesty_type[fold.test_index]).groupby(
        dataset.keys["agent_id"].to_numpy()[fold.test_index]
    ).first()
    record: Dict[str, Any] = {
        "repeat": fold.repeat,
        "fold": fold.fold,
        "n_train": len(fold.train_index),
        "train_prevalence": float(dataset.labels[fold.train_index].mean()),
        "n_inner_train": len(fold.inner_train_index),
        "n_inner_val": len(fold.inner_val_index),
        "inner_val_positives": int(dataset.labels[fold.inner_val_index].sum()),
        "n_test": len(fold.test_index),
        "test_positives": int(dataset.labels[fold.test_index].sum()),
        "test_prevalence": float(dataset.labels[fold.test_index].mean()),
        "n_test_agents": int(len(test_agents)),
    }
    for honesty_type, count in test_agents.value_counts().items():
        record[f"test_agents_{honesty_type}"] = int(count)
    typologies = pd.Series(dataset.typology[fold.test_index][dataset.labels[fold.test_index] == 1])
    for typology, count in typologies.value_counts().items():
        record[f"test_positives_{typology}"] = int(count)
    return record


def _run_fold(
    dataset: data_module.Dataset, fold: Fold, model_cfg: Dict[str, Any], records: RunRecords
) -> None:
    xgb_cfg = model_cfg["xgboost"]
    rng = np.random.default_rng(
        derived_seed(int(model_cfg["cross_validation"]["cv_seed"]), fold.repeat, fold.fold, 1)
    )
    candidates = sample_candidates(xgb_cfg["search_space"], int(xgb_cfg["search_iterations"]), rng)
    records.folds.append(_fold_record(dataset, fold))
    for spec in MODEL_SPECS:
        scores = _score(spec, dataset, fold, candidates, model_cfg, records)
        records.predictions.append(
            pd.DataFrame({
                "repeat": fold.repeat,
                "fold": fold.fold,
                "model": spec.name,
                "activation_id": dataset.keys["activation_id"].to_numpy()[fold.test_index],
                "score": scores.astype(np.float32),
            })
        )


def config_hashes() -> Dict[str, str]:
    """Hashes of the config files as they are right now.

    Taken when the run starts, not when the manifest is written, so that editing
    a config during a long run cannot record a hash the run never used.
    """
    return {
        "config_hash": config_module.config_hash(
            [config_module.GENERATOR_CONFIG, config_module.MODEL_CONFIG]
        ),
        "generator_config_hash": config_module.config_hash([config_module.GENERATOR_CONFIG]),
        "model_config_hash": config_module.config_hash([config_module.MODEL_CONFIG]),
    }


def _manifest(
    gen_cfg: Dict[str, Any],
    model_cfg: Dict[str, Any],
    data_manifest: Dict[str, Any],
    runtime: float,
    hashes: Dict[str, str],
) -> Dict[str, Any]:
    bounds = time_boundaries(gen_cfg, model_cfg)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "cv_seed": int(model_cfg["cross_validation"]["cv_seed"]),
        **hashes,
        "data_manifest": {
            key: data_manifest[key] for key in ("generated_at", "seed", "generator_config_hash")
        } | {"realised_fraud_rate": data_manifest["summary"]["realised_fraud_rate"]},
        "package_versions": config_module.package_versions(
            ["numpy", "pandas", "scikit-learn", "xgboost", "imbalanced-learn"]
        ),
        "time_boundaries": {
            "test_start": str(bounds.test_start),
            "inner_val_start": str(bounds.inner_val_start),
            "embargo_days": bounds.embargo.days,
        },
        "models": [asdict(spec) for spec in MODEL_SPECS],
        "feature_sets": {name: list(cols) for name, cols in data_module.FEATURE_SETS.items()},
        "runtime_seconds": round(runtime, 1),
    }


def train(gen_cfg: Dict[str, Any], model_cfg: Dict[str, Any]) -> RunRecords:
    hashes = config_hashes()
    data_manifest = data_module.check_provenance()
    dataset = data_module.load_dataset()
    folds = build_folds(dataset.keys, dataset.labels, gen_cfg, model_cfg)
    records = RunRecords(predictions=[], folds=[], params=[], importance=[])
    started = time.perf_counter()
    for fold in folds:
        _run_fold(dataset, fold, model_cfg, records)
        print(f"repeat {fold.repeat} fold {fold.fold} done, {time.perf_counter() - started:.0f}s")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    pd.concat(records.predictions, ignore_index=True).to_parquet(PREDICTIONS_PATH, index=False)
    pd.DataFrame(records.folds).to_csv(OUTPUT_DIR / "cv_folds.csv", index=False)
    pd.DataFrame(records.params).to_csv(OUTPUT_DIR / "xgb_selected_params.csv", index=False)
    pd.concat(records.importance, ignore_index=True).to_csv(
        OUTPUT_DIR / "xgb_feature_importance.csv", index=False
    )
    manifest = _manifest(gen_cfg, model_cfg, data_manifest, time.perf_counter() - started, hashes)
    (OUTPUT_DIR / "training_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return records


def main() -> None:
    gen_cfg = config_module.load_config(config_module.GENERATOR_CONFIG)
    model_cfg = config_module.load_config(config_module.MODEL_CONFIG)
    train(gen_cfg, model_cfg)
    results.write_all(gen_cfg, model_cfg)


if __name__ == "__main__":
    main()
