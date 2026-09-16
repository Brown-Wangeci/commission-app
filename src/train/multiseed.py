"""Train the Phase 5 models across every seed, with calibrated probabilities.

Usage: python -m src.train.multiseed

Seed 42 is no longer the headline. Each seed in `multi_seed.seeds` gets its own
generated dataset, its own folds, and its own out-of-fold predictions, so every
reported number can be a mean across seeds with the seed-level spread.

Within each fold the training split is divided by agent: the model is fitted on
one part and the probability calibrator on the other, which the model has never
seen. Test rows are touched by neither. For every test row this writes the raw
score and one calibrated probability per method, so calibration can be judged
and the decision bands can be set on probabilities rather than on scores.
"""

from __future__ import annotations

import copy
import json
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List

import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression

from ..eval.cv import Fold, build_folds, derived_seed
from ..generator import config as config_module
from ..generator.run import generate
from .data import FEATURE_SETS
from .models import fit_xgboost
from .search import sample_candidates, search_xgboost

OUTPUT_DIR = config_module.REPO_ROOT / "outputs"
PREDICTIONS_PATH = OUTPUT_DIR / "multiseed_predictions.parquet"
MODELS_PATH = OUTPUT_DIR / "multiseed_fold_models.pkl"


@dataclass(frozen=True)
class ModelSpec:
    name: str
    feature_set: str
    method: str


def model_specs(model_cfg: Dict[str, Any]) -> List[ModelSpec]:
    return [ModelSpec(**spec) for spec in model_cfg["multi_seed"]["models"]]


def fit_calibrators(
    scores: np.ndarray, labels: np.ndarray, methods: List[str]
) -> Dict[str, Any]:
    """One calibrator per method, fitted on held-out agents' scores."""
    calibrators: Dict[str, Any] = {}
    for method in methods:
        if method == "isotonic":
            model = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
            model.fit(scores, labels)
        elif method == "sigmoid":
            model = LogisticRegression()
            model.fit(scores.reshape(-1, 1), labels)
        else:
            raise ValueError(f"unknown calibration method {method}")
        calibrators[method] = model
    return calibrators


def apply_calibrator(method: str, calibrator: Any, scores: np.ndarray) -> np.ndarray:
    if method == "isotonic":
        return np.asarray(calibrator.predict(scores), dtype=float)
    return calibrator.predict_proba(scores.reshape(-1, 1))[:, 1]


def run_fold(
    dataset: Dict[str, Any],
    fold: Fold,
    spec: ModelSpec,
    model_cfg: Dict[str, Any],
    seed: int,
) -> tuple[pd.DataFrame, Dict[str, Any], Any]:
    """Search, fit, calibrate and score one model on one fold."""
    xgb_cfg = model_cfg["xgboost"]
    methods = [str(m) for m in model_cfg["calibration"]["methods"]]
    matrix = dataset["features"][list(FEATURE_SETS[spec.feature_set])]
    labels = dataset["labels"]
    cv_seed = int(model_cfg["cross_validation"]["cv_seed"])
    fold_seed = derived_seed(cv_seed, seed, fold.fold)

    rng = np.random.default_rng(derived_seed(cv_seed, seed, fold.fold, 1))
    candidates = sample_candidates(xgb_cfg["search_space"], int(xgb_cfg["search_iterations"]), rng)
    search = search_xgboost(
        (matrix.iloc[fold.inner_train_index], labels[fold.inner_train_index]),
        (matrix.iloc[fold.inner_val_index], labels[fold.inner_val_index]),
        candidates, spec.method, model_cfg, fold_seed,
    )

    fit_rows = fold.model_fit_rows()
    model = fit_xgboost(
        matrix.iloc[fit_rows], labels[fit_rows], search.best, spec.method, model_cfg, fold_seed
    )
    calibration_scores = model.predict_proba(matrix.iloc[fold.calibration_index])[:, 1]
    calibrators = fit_calibrators(
        calibration_scores, labels[fold.calibration_index], methods
    )

    test_scores = model.predict_proba(matrix.iloc[fold.test_index])[:, 1]
    predictions = pd.DataFrame({
        "seed": seed,
        "fold": fold.fold,
        "model": spec.name,
        "activation_id": dataset["keys"]["activation_id"].to_numpy()[fold.test_index],
        "label": labels[fold.test_index],
        "uncalibrated": test_scores.astype(np.float32),
    })
    for method, calibrator in calibrators.items():
        predictions[method] = apply_calibrator(method, calibrator, test_scores).astype(np.float32)

    record = {
        "seed": seed, "fold": fold.fold, "model": spec.name,
        "n_fit": len(fit_rows), "n_calibration": len(fold.calibration_index),
        "n_test": len(fold.test_index),
        "calibration_positives": int(labels[fold.calibration_index].sum()),
        "test_positives": int(labels[fold.test_index].sum()),
        "test_prevalence": float(labels[fold.test_index].mean()),
        "inner_val_pr_auc": search.best_inner_pr_auc,
        **search.best,
    }
    return predictions, record, model


def shap_sample(
    dataset: Dict[str, Any], fold: Fold, spec: ModelSpec, model: Any, seed: int, sample_size: int
) -> pd.DataFrame:
    """SHAP values and the feature values behind them, for a sample of test rows.

    Computed here rather than from a stored model, so nothing has to be pickled
    and the explanation always belongs to the model that produced the scores.
    """
    import shap

    columns = list(FEATURE_SETS[spec.feature_set])
    rows = fold.test_index
    if len(rows) > sample_size:
        rng = np.random.default_rng(derived_seed(seed, fold.fold, 2))
        rows = np.sort(rng.choice(rows, size=sample_size, replace=False))
    matrix = dataset["features"][columns].iloc[rows]
    values = shap.TreeExplainer(model).shap_values(matrix)
    frame = pd.DataFrame(values, columns=[f"shap_{name}" for name in columns])
    frame.insert(0, "activation_id", dataset["keys"]["activation_id"].to_numpy()[rows])
    frame.insert(0, "fold", fold.fold)
    frame.insert(0, "seed", seed)
    for name in columns:
        frame[f"value_{name}"] = matrix[name].to_numpy()
    return frame


def run_seed(
    gen_cfg: Dict[str, Any], model_cfg: Dict[str, Any], seed: int
) -> Dict[str, Any]:
    seeded = copy.deepcopy(gen_cfg)
    seeded["seed"] = seed
    single = copy.deepcopy(model_cfg)
    single["cross_validation"]["n_repeats"] = int(model_cfg["multi_seed"]["n_repeats"])

    observable, internal, features, manifest = generate(write=False, cfg=seeded)
    aligned = internal.labels.set_index("activation_id").reindex(features.keys["activation_id"])
    dataset = {
        "keys": features.keys,
        "features": pd.concat([features.t0, features.t7], axis=1),
        "labels": aligned["is_fraudulent"].to_numpy().astype(int),
        "typology": aligned["fraud_typology"].to_numpy().astype(str),
        "honesty_type": aligned["honesty_type"].to_numpy().astype(str),
        "flags": aligned[[c for c in aligned.columns if c.startswith("flag_")]].reset_index(drop=True),
    }
    folds = build_folds(dataset["keys"], dataset["labels"], seeded, single, with_calibration=True)
    chosen = str(model_cfg["multi_seed"]["chosen_model"])
    sample_size = int(model_cfg["explanations"]["shap_rows_per_fold"])

    predictions, records, explanations = [], [], []
    for fold in folds:
        for spec in model_specs(model_cfg):
            frame, record, model = run_fold(dataset, fold, spec, model_cfg, seed)
            predictions.append(frame)
            records.append(record)
            if spec.name == chosen:
                explanations.append(shap_sample(dataset, fold, spec, model, seed, sample_size))
        print(f"seed {seed} fold {fold.fold} done")

    commission = (
        observable.activations.set_index("activation_id")["escrow_amount"]
        .reindex(dataset["keys"]["activation_id"]) * float(gen_cfg["workload"]["commission_rate"])
    )
    context = pd.DataFrame({
        "activation_id": dataset["keys"]["activation_id"].to_numpy(),
        "seed": seed,
        "typology": dataset["typology"],
        "honesty_type": dataset["honesty_type"],
        "commission_value": commission.to_numpy(),
    })
    for column in dataset["flags"].columns:
        context[column] = dataset["flags"][column].to_numpy()
    return {
        "predictions": predictions,
        "records": records,
        "context": context,
        "explanations": explanations,
        "summary": {
            "seed": seed,
            "activations": manifest["summary"]["num_activations"],
            "realised_fraud_rate": manifest["summary"]["realised_fraud_rate"],
            "days": int(gen_cfg["simulation"]["num_days"]),
            "mean_daily_activations": manifest["summary"]["num_activations"] / int(gen_cfg["simulation"]["num_days"]),
            "mean_commission_value_kes": float(commission.mean()),
        },
    }


def main() -> None:
    gen_cfg = config_module.load_config(config_module.GENERATOR_CONFIG)
    model_cfg = config_module.load_config(config_module.MODEL_CONFIG)
    hashes = {
        "generator_config_hash": config_module.config_hash([config_module.GENERATOR_CONFIG]),
        "model_config_hash": config_module.config_hash([config_module.MODEL_CONFIG]),
    }
    started = time.perf_counter()

    all_predictions, all_records, all_context, all_explanations, seed_summaries = [], [], [], [], []
    for seed in [int(s) for s in model_cfg["multi_seed"]["seeds"]]:
        result = run_seed(gen_cfg, model_cfg, seed)
        all_predictions.extend(result["predictions"])
        all_records.extend(result["records"])
        all_context.append(result["context"])
        all_explanations.extend(result["explanations"])
        seed_summaries.append(result["summary"])

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    pd.concat(all_predictions, ignore_index=True).to_parquet(PREDICTIONS_PATH, index=False)
    pd.concat(all_context, ignore_index=True).to_parquet(
        OUTPUT_DIR / "multiseed_row_context.parquet", index=False
    )
    pd.concat(all_explanations, ignore_index=True).to_parquet(
        OUTPUT_DIR / "multiseed_shap.parquet", index=False
    )
    pd.DataFrame(all_records).to_csv(OUTPUT_DIR / "multiseed_fold_records.csv", index=False, float_format="%.6g")
    pd.DataFrame(seed_summaries).to_csv(OUTPUT_DIR / "multiseed_seed_summary.csv", index=False, float_format="%.6g")

    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        **hashes,
        "seeds": [int(s) for s in model_cfg["multi_seed"]["seeds"]],
        "n_repeats": int(model_cfg["multi_seed"]["n_repeats"]),
        "models": [asdict(spec) for spec in model_specs(model_cfg)],
        "calibration_methods": list(model_cfg["calibration"]["methods"]),
        "package_versions": config_module.package_versions(
            ["numpy", "pandas", "scikit-learn", "xgboost", "imbalanced-learn", "shap"]
        ),
        "runtime_seconds": round(time.perf_counter() - started, 1),
    }
    (OUTPUT_DIR / "multiseed_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
