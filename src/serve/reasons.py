"""Turn SHAP contributions into admin-facing reason strings.

Templates come from config/reason_phrases.yaml, never from code, per the
Phase 7 review. Every T0/T7 feature must have an entry there; a missing one
is a startup error rather than a silent fallback, since a raw feature name
reaching an admin's screen is exactly what this module exists to prevent.

`is_agent_level` mirrors AGENT_HISTORY_FEATURES (src/train/data.py): it marks
a reason that describes the agent's recent history rather than this specific
activation or its customer, so a response can show an admin when they are
being told about the person rather than the job (Phase 5 E4: agent-history
features carried 35.6% of the model's explanation mass).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Sequence

from ..generator import config as config_module
from . import settings

SECONDS_PER_HOUR = 3600.0


@dataclass(frozen=True)
class Reason:
    feature: str
    is_agent_level: bool
    direction: str
    shap_value: float
    description: str


def load_phrases(
    features: Sequence[str], serving_cfg: Dict[str, Any] | None = None
) -> Dict[str, Any]:
    """Load and validate the mapping. Fails loudly if any feature is uncovered."""
    path = settings.reason_phrases_path(serving_cfg)
    raw = config_module.load_config(path)["features"]
    missing = [name for name in features if name not in raw]
    if missing:
        raise KeyError(
            f"config/reason_phrases.yaml has no reason template for: {sorted(missing)}"
        )
    return raw


def _describe(value: float, spec: Dict[str, Any]) -> str:
    kind = spec.get("kind", "numeric")
    if kind == "hours":
        return str(spec["template"]).format(value=value / SECONDS_PER_HOUR)
    if kind == "flag":
        template = spec["template_true"] if value >= 0.5 else spec["template_false"]
        return str(template)
    return str(spec["template"]).format(value=value)


def top_reasons(
    feature_values: Dict[str, float],
    shap_values: Dict[str, float],
    phrases: Dict[str, Any],
    count: int,
) -> List[Reason]:
    """The `count` features with the largest absolute SHAP contribution, in plain language."""
    ranked = sorted(shap_values.items(), key=lambda item: abs(item[1]), reverse=True)[:count]
    reasons = []
    for name, contribution in ranked:
        spec = phrases[name]
        reasons.append(Reason(
            feature=name,
            is_agent_level=bool(spec.get("agent_level", False)),
            direction="raises" if contribution > 0 else "lowers",
            shap_value=float(contribution),
            description=_describe(feature_values[name], spec),
        ))
    return reasons
