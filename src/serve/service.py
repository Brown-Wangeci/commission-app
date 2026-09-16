"""Core scoring logic, independent of FastAPI so it can be tested directly.

Loads both artifacts once at construction: "t7" (hold-close, the chosen
model) and "t0" (submission-time). Every call to `score` picks one by mode
and reuses its loaded booster, calibrator and SHAP explainer; nothing is
refit per request.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List

import shap

from ..generator import config as config_module
from . import artifact as artifact_module
from . import observable as observable_module
from . import reasons as reasons_module
from . import settings
from . import storage

MODES = ("t0", "t7")


@dataclass(frozen=True)
class ScoredActivation:
    activation_id: str
    mode: str
    feature_set: str
    model_version: str
    scored_at: datetime
    raw_score: float
    calibrated_probability: float
    band: str
    release_threshold: float
    reject_threshold: float
    feature_vector: Dict[str, float]
    top_reasons: List[reasons_module.Reason] = field(default_factory=list)


class ScoringService:
    """Owns both loaded artifacts, their SHAP explainers and the database handle."""

    def __init__(
        self,
        serving_cfg: Dict[str, Any] | None = None,
        gen_cfg: Dict[str, Any] | None = None,
        artifacts: Dict[str, artifact_module.LoadedArtifact] | None = None,
        db: storage.Storage | None = None,
    ) -> None:
        self.serving_cfg = serving_cfg or settings.load_serving_config()
        self.gen_cfg = gen_cfg or config_module.load_config(config_module.GENERATOR_CONFIG)
        self.artifacts = artifacts or {
            "t7": artifact_module.load_artifact(str(self.serving_cfg["model_version"]), self.serving_cfg),
            "t0": artifact_module.load_artifact(str(self.serving_cfg["t0_model_version"]), self.serving_cfg),
        }
        self.explainers = {
            mode: shap.TreeExplainer(artifact.booster) for mode, artifact in self.artifacts.items()
        }
        self.phrases = {
            mode: reasons_module.load_phrases(artifact.features, self.serving_cfg)
            for mode, artifact in self.artifacts.items()
        }
        self.config_hash = config_module.config_hash(
            [config_module.GENERATOR_CONFIG, config_module.MODEL_CONFIG]
        )
        self.db = db or storage.Storage(settings.db_path(self.serving_cfg))
        self.top_reason_count = int(self.serving_cfg["top_reason_count"])

    @property
    def artifact(self) -> artifact_module.LoadedArtifact:
        """The chosen (T7) artifact, for callers that only ever meant that one."""
        return self.artifacts["t7"]

    def assign_band(self, probability: float, mode: str = "t7") -> str:
        return self.artifacts[mode].assign_band(probability)

    def score(
        self,
        mode: str,
        activation: Dict[str, Any],
        agents: List[Dict[str, Any]],
        recent_activations: List[Dict[str, Any]],
        payout_calendar: List[Dict[str, Any]],
        downstream_activity: List[Dict[str, Any]],
        persist: bool = True,
    ) -> ScoredActivation:
        if mode not in MODES:
            raise ValueError(f"unknown mode {mode!r}, expected one of {MODES}")
        artifact = self.artifacts[mode]

        row = observable_module.score_row_features(
            activation, recent_activations, agents, payout_calendar, downstream_activity, self.gen_cfg
        )
        feature_row = row[list(artifact.features)].astype(float)
        matrix = feature_row.to_frame().T
        matrix.columns = list(artifact.features)

        raw_score = float(artifact.booster.predict_proba(matrix)[0, 1])
        probability = float(artifact.calibrate([raw_score])[0])
        band = artifact.assign_band(probability)

        shap_row = self.explainers[mode].shap_values(matrix)[0]
        shap_map = dict(zip(artifact.features, (float(v) for v in shap_row)))
        top = reasons_module.top_reasons(
            feature_row.to_dict(), shap_map, self.phrases[mode], self.top_reason_count
        )

        scored = ScoredActivation(
            activation_id=str(activation["activation_id"]),
            mode=mode,
            feature_set=artifact.feature_set,
            model_version=artifact.version,
            scored_at=datetime.now(timezone.utc),
            raw_score=raw_score,
            calibrated_probability=probability,
            band=band,
            release_threshold=artifact.release_threshold,
            reject_threshold=artifact.reject_threshold,
            feature_vector=feature_row.to_dict(),
            top_reasons=top,
        )
        if persist:
            self.db.save(scored, self.config_hash)
        return scored
