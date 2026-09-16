"""Build, serialise and load the deployable model artifact.

Usage: python -m src.serve.artifact

Writes artifacts/<version>/ containing:
  model.json       - the XGBoost booster, native JSON format
  calibrator.pkl   - the fitted isotonic calibrator (joblib)
  manifest.json    - everything needed to describe the artifact: feature
                     list, provenance, thresholds, cost matrix, and the
                     Phase 5/6 performance numbers it was chosen on

No analysis happens here. The performance numbers, thresholds and cost
matrix are copied from files already written by Phase 5/6 (outputs/); this
module trains one production model and records what produced it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict

import joblib
import pandas as pd
from xgboost import XGBClassifier

from ..generator import config as config_module
from ..train.production import ProductionModel, train_production_model
from . import settings

OUTPUT_DIR = config_module.REPO_ROOT / "outputs"
MODEL_FILENAME = "model.json"
CALIBRATOR_FILENAME = "calibrator.pkl"
MANIFEST_FILENAME = "manifest.json"


@dataclass(frozen=True)
class LoadedArtifact:
    """The deployable model, ready to score requests."""

    version: str
    booster: XGBClassifier
    calibrator: Any
    features: tuple
    release_threshold: float
    reject_threshold: float
    manifest: Dict[str, Any]


def _read_csv_row(path: Path, **filters: Any) -> Dict[str, Any] | None:
    if not path.exists():
        return None
    frame = pd.read_csv(path)
    for column, value in filters.items():
        frame = frame[frame[column] == value]
    if frame.empty:
        return None
    return frame.iloc[0].to_dict()


def _operating_thresholds() -> Dict[str, float]:
    row = _read_csv_row(
        OUTPUT_DIR / "band_operating_point.csv", variant="chosen (capacity constrained)"
    )
    if row is None:
        raise FileNotFoundError(
            "outputs/band_operating_point.csv is missing the chosen operating point; "
            "run python -m src.eval.bands first"
        )
    return {
        "release_threshold": float(row["release_threshold"]),
        "reject_threshold": float(row["reject_threshold"]),
    }


def _performance_summary(model_name: str) -> Dict[str, Any] | None:
    path = OUTPUT_DIR / "multiseed_results_summary.csv"
    if not path.exists():
        return None
    frame = pd.read_csv(path)
    frame = frame[frame["model"] == model_name]
    if frame.empty:
        return None
    return {
        key: float(frame.iloc[0][key])
        for key in frame.columns
        if key != "model" and pd.api.types.is_numeric_dtype(frame[key])
    }


def _cost_matrix_snapshot() -> list[Dict[str, Any]] | None:
    path = OUTPUT_DIR / "cost_matrix.csv"
    if not path.exists():
        return None
    return pd.read_csv(path).to_dict(orient="records")


def build_manifest(model: ProductionModel, version: str) -> Dict[str, Any]:
    from datetime import datetime, timezone

    thresholds = _operating_thresholds()
    return {
        "version": version,
        "built_at": datetime.now(timezone.utc).isoformat(),
        "model_type": "XGBoost binary classifier (gradient-boosted trees), isotonic-calibrated",
        "feature_set": model.feature_set,
        "features": list(model.features),
        "imbalance_method": model.method,
        "hyperparameters": model.hyperparameters,
        "inner_val_pr_auc": model.inner_val_pr_auc,
        "training": {
            "n_fit_rows": model.n_fit_rows,
            "n_calibration_rows": model.n_calibration_rows,
            "n_total_rows": model.n_total_rows,
            "training_seed": model.training_seed,
        },
        "provenance": {
            "data": "synthetic, produced by src/generator (see docs/data_dictionary.md)",
            "generator_config_hash": model.generator_config_hash,
            "model_config_hash": model.model_config_hash,
            "dataset": model.dataset_provenance,
        },
        "operating_thresholds": thresholds,
        "cost_matrix": _cost_matrix_snapshot(),
        "cross_validated_performance": {
            "note": "Phase 5/6 out-of-fold performance across seeds 7, 42, 101, 2024; "
                    "not measured on this artifact, which is trained on all of that data",
            model.feature_set + "_" + model.method: _performance_summary(
                f"{model.feature_set}_{model.method}"
            ),
        },
    }


def build_and_save(version: str | None = None) -> Path:
    cfg = settings.load_serving_config()
    version = version or str(cfg["model_version"])
    gen_cfg = config_module.load_config(config_module.GENERATOR_CONFIG)
    model_cfg = config_module.load_config(config_module.MODEL_CONFIG)

    model = train_production_model(gen_cfg, model_cfg)
    manifest = build_manifest(model, version)

    out_dir = settings.artifact_dir(cfg) / version
    out_dir.mkdir(parents=True, exist_ok=True)
    model.booster.save_model(str(out_dir / MODEL_FILENAME))
    joblib.dump(model.calibrator, out_dir / CALIBRATOR_FILENAME)
    (out_dir / MANIFEST_FILENAME).write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    (settings.artifact_dir(cfg) / "CURRENT").write_text(version, encoding="utf-8")
    return out_dir


def load_artifact(version: str | None = None) -> LoadedArtifact:
    cfg = settings.load_serving_config()
    base = settings.artifact_dir(cfg)
    version = version or str(cfg["model_version"])
    out_dir = base / version
    manifest = json.loads((out_dir / MANIFEST_FILENAME).read_text(encoding="utf-8"))

    booster = XGBClassifier()
    booster.load_model(str(out_dir / MODEL_FILENAME))
    calibrator = joblib.load(out_dir / CALIBRATOR_FILENAME)
    thresholds = manifest["operating_thresholds"]

    return LoadedArtifact(
        version=manifest["version"],
        booster=booster,
        calibrator=calibrator,
        features=tuple(manifest["features"]),
        release_threshold=float(thresholds["release_threshold"]),
        reject_threshold=float(thresholds["reject_threshold"]),
        manifest=manifest,
    )


def main() -> None:
    out_dir = build_and_save()
    print(f"artifact written to {out_dir}")
    artifact = load_artifact()
    print(f"version: {artifact.version}")
    print(f"features: {len(artifact.features)}")
    print(f"release threshold: {artifact.release_threshold:.6f}")
    print(f"reject threshold: {artifact.reject_threshold:.6f}")


if __name__ == "__main__":
    main()
