"""Core scoring logic, independent of FastAPI so it can be tested directly.

Loads the artifact once at construction. Every call to `score` reuses the
loaded booster, calibrator and SHAP explainer; nothing is refit per request.
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


@dataclass(frozen=True)
class ScoredActivation:
    activation_id: str
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
    """Owns the loaded artifact, the SHAP explainer and the database handle."""

    def __init__(
        self,
        serving_cfg: Dict[str, Any] | None = None,
        gen_cfg: Dict[str, Any] | None = None,
        artifact: artifact_module.LoadedArtifact | None = None,
        db: storage.Storage | None = None,
    ) -> None:
        self.serving_cfg = serving_cfg or settings.load_serving_config()
        self.gen_cfg = gen_cfg or config_module.load_config(config_module.GENERATOR_CONFIG)
        self.artifact = artifact or artifact_module.load_artifact(
            str(self.serving_cfg["model_version"])
        )
        self.explainer = shap.TreeExplainer(self.artifact.booster)
        self.phrases = reasons_module.load_phrases(self.artifact.features, self.serving_cfg)
        self.config_hash = config_module.config_hash(
            [config_module.GENERATOR_CONFIG, config_module.MODEL_CONFIG]
        )
        self.db = db or storage.Storage(settings.db_path(self.serving_cfg))
        self.top_reason_count = int(self.serving_cfg["top_reason_count"])

    def assign_band(self, probability: float) -> str:
        """Release at or below the release threshold, refuse strictly above the
        reject threshold; the same convention src/eval/bands.py and
        src/eval/fairness.py use, so a boundary case is classified identically
        wherever it is evaluated."""
        if probability <= self.artifact.release_threshold:
            return "auto_release"
        if probability <= self.artifact.reject_threshold:
            return "review"
        return "reject"

    def score(
        self,
        activation: Dict[str, Any],
        agents: List[Dict[str, Any]],
        recent_activations: List[Dict[str, Any]],
        payout_calendar: List[Dict[str, Any]],
        downstream_activity: List[Dict[str, Any]],
        persist: bool = True,
    ) -> ScoredActivation:
        row = observable_module.score_row_features(
            activation, recent_activations, agents, payout_calendar, downstream_activity, self.gen_cfg
        )
        feature_row = row[list(self.artifact.features)].astype(float)
        matrix = feature_row.to_frame().T
        matrix.columns = list(self.artifact.features)

        raw_score = float(self.artifact.booster.predict_proba(matrix)[0, 1])
        probability = float(self.artifact.calibrator.predict([raw_score])[0])
        band = self.assign_band(probability)

        shap_row = self.explainer.shap_values(matrix)[0]
        shap_map = dict(zip(self.artifact.features, (float(v) for v in shap_row)))
        top = reasons_module.top_reasons(
            feature_row.to_dict(), shap_map, self.phrases, self.top_reason_count
        )

        scored = ScoredActivation(
            activation_id=str(activation["activation_id"]),
            model_version=self.artifact.version,
            scored_at=datetime.now(timezone.utc),
            raw_score=raw_score,
            calibrated_probability=probability,
            band=band,
            release_threshold=self.artifact.release_threshold,
            reject_threshold=self.artifact.reject_threshold,
            feature_vector=feature_row.to_dict(),
            top_reasons=top,
        )
        if persist:
            self.db.save(scored, self.config_hash)
        return scored
