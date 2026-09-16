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
import numpy as np
import pandas as pd
from xgboost import XGBClassifier

from ..generator import config as config_module
from ..train.production import ProductionModel, train_production_model
from . import settings

OUTPUT_DIR = config_module.REPO_ROOT / "outputs"
MODEL_FILENAME = "model.json"
CALIBRATOR_FILENAME = "calibrator.pkl"
MANIFEST_FILENAME = "manifest.json"

# Which model's Phase 6-style band optimisation each model reads its
# thresholds from. t7_none is the chosen model, optimised in Phase 6;
# t0_none is optimised the same way by src/serve/bands_t0.py (Phase 8).
THRESHOLD_FILES = {
    "t7_none": OUTPUT_DIR / "band_operating_point.csv",
    "t0_none": OUTPUT_DIR / "band_operating_point_t0.csv",
}


@dataclass(frozen=True)
class LoadedArtifact:
    """The deployable model, ready to score requests."""

    version: str
    feature_set: str
    booster: XGBClassifier
    calibrator: Any
    features: tuple
    release_threshold: float
    reject_threshold: float
    probability_clip: tuple[float, float]
    manifest: Dict[str, Any]

    def calibrate(self, raw_scores: Any) -> np.ndarray:
        """Map raw scores to calibrated probabilities, clipped to
        `probability_clip`. The one place calibration happens, so the
        service and any offline comparison of the same artifact clip
        identically. Isotonic regression saturates at the endpoints, and a
        system that refuses a payout cannot claim certainty."""
        probability = np.asarray(self.calibrator.predict(np.atleast_1d(raw_scores)), dtype=float)
        low, high = self.probability_clip
        return np.clip(probability, low, high)

    def assign_band(self, probability: float) -> str:
        """Release at or below the release threshold, refuse strictly above
        the reject threshold; the same convention src/eval/bands.py and
        src/eval/fairness.py use, so a boundary case is classified
        identically wherever it is evaluated."""
        if probability <= self.release_threshold:
            return "auto_release"
        if probability <= self.reject_threshold:
            return "review"
        return "reject"


def _read_csv_row(path: Path, **filters: Any) -> Dict[str, Any] | None:
    if not path.exists():
        return None
    frame = pd.read_csv(path)
    for column, value in filters.items():
        frame = frame[frame[column] == value]
    if frame.empty:
        return None
    return frame.iloc[0].to_dict()


def _operating_thresholds(path: Path) -> Dict[str, float]:
    row = _read_csv_row(path, variant="chosen (capacity constrained)")
    if row is None:
        raise FileNotFoundError(
            f"{path} is missing the chosen operating point; run the matching "
            "band optimisation first (src.eval.bands for t7_none, "
            "src.serve.bands_t0 for t0_none)"
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


def build_manifest(model: ProductionModel, version: str, thresholds_path: Path) -> Dict[str, Any]:
    from datetime import datetime, timezone

    thresholds = _operating_thresholds(thresholds_path)
    model_key = f"{model.feature_set}_{model.method}"
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
        "operating_thresholds_source": str(thresholds_path.name),
        "cost_matrix": _cost_matrix_snapshot(),
        "cross_validated_performance": {
            "note": "Phase 5/6 out-of-fold performance across seeds 7, 42, 101, 2024, "
                    "measured on a different (multi-seed CV) run, not on this artifact -- "
                    "this artifact is trained on a single dataset (seed 42) and has no "
                    "held-out set of its own",
            model_key: _performance_summary(model_key),
        },
    }


def build_and_save(version: str | None = None, model_name: str | None = None) -> Path:
    """Train, serialise and record one artifact.

    With no arguments this rebuilds the chosen (T7) artifact exactly as
    before, and updates the `CURRENT` pointer. Passing `model_name="t0_none"`
    builds the T0 artifact instead; `version` must then be given explicitly,
    since config/serving.yaml only names a default version for the chosen
    model, and the T0 artifact does not replace `CURRENT`.
    """
    cfg = settings.load_serving_config()
    gen_cfg = config_module.load_config(config_module.GENERATOR_CONFIG)
    model_cfg = config_module.load_config(config_module.MODEL_CONFIG)
    chosen_name = str(model_cfg["multi_seed"]["chosen_model"])
    resolved_name = model_name or chosen_name

    if version is None:
        if resolved_name != chosen_name:
            raise ValueError(f"version must be given explicitly when building {resolved_name!r}")
        version = str(cfg["model_version"])

    thresholds_path = THRESHOLD_FILES.get(resolved_name)
    if thresholds_path is None:
        raise ValueError(f"no threshold file mapping for model {resolved_name!r}")

    model = train_production_model(gen_cfg, model_cfg, model_name=resolved_name)
    manifest = build_manifest(model, version, thresholds_path)

    out_dir = settings.artifact_dir(cfg) / version
    out_dir.mkdir(parents=True, exist_ok=True)
    model.booster.save_model(str(out_dir / MODEL_FILENAME))
    joblib.dump(model.calibrator, out_dir / CALIBRATOR_FILENAME)
    (out_dir / MANIFEST_FILENAME).write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    if resolved_name == chosen_name:
        (settings.artifact_dir(cfg) / "CURRENT").write_text(version, encoding="utf-8")
    return out_dir


def load_artifact(version: str | None = None, serving_cfg: Dict[str, Any] | None = None) -> LoadedArtifact:
    cfg = serving_cfg or settings.load_serving_config()
    base = settings.artifact_dir(cfg)
    version = version or str(cfg["model_version"])
    out_dir = base / version
    manifest = json.loads((out_dir / MANIFEST_FILENAME).read_text(encoding="utf-8"))

    booster = XGBClassifier()
    booster.load_model(str(out_dir / MODEL_FILENAME))
    calibrator = joblib.load(out_dir / CALIBRATOR_FILENAME)
    thresholds = manifest["operating_thresholds"]
    clip = (float(cfg["probability_clip_low"]), float(cfg["probability_clip_high"]))

    return LoadedArtifact(
        version=manifest["version"],
        feature_set=str(manifest["feature_set"]),
        booster=booster,
        calibrator=calibrator,
        features=tuple(manifest["features"]),
        release_threshold=float(thresholds["release_threshold"]),
        reject_threshold=float(thresholds["reject_threshold"]),
        probability_clip=clip,
        manifest=manifest,
    )


def main() -> None:
    import sys

    model_name = sys.argv[1] if len(sys.argv) > 1 else None
    version = sys.argv[2] if len(sys.argv) > 2 else None
    out_dir = build_and_save(version=version, model_name=model_name)
    print(f"artifact written to {out_dir}")
    artifact = load_artifact(version)  # version is resolved by build_and_save when None
    print(f"version: {artifact.version}")
    print(f"feature set: {artifact.feature_set}")
    print(f"features: {len(artifact.features)}")
    print(f"release threshold: {artifact.release_threshold:.6f}")
    print(f"reject threshold: {artifact.reject_threshold:.6f}")
    print(f"probability clip: {artifact.probability_clip}")


if __name__ == "__main__":
    main()
