"""Load the generated dataset for training.

Features come from data/features.parquet, which feature code built from the
observable log alone. The label and the typology come from the separate
internal labels file and are used only as training targets and for
evaluation breakdowns, never as model inputs.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Tuple

import numpy as np
import pandas as pd

from ..generator import config as config_module
from ..generator.features import KEY_COLUMNS, T0_FEATURES, T7_FEATURES

DATA_DIR = config_module.REPO_ROOT / "data"
RUN_MANIFEST = config_module.REPO_ROOT / "outputs" / "run_manifest.json"

# Features describing the agent's recent history rather than this activation or
# its customer. The Phase 4 ablation removes them to separate "this agent looks
# risky" from "this activation looks wrong".
AGENT_HISTORY_FEATURES: Tuple[str, ...] = (
    "agent_tenure_days",
    "agent_activation_velocity_1h",
    "agent_activation_velocity_24h",
    "device_activations_7d",
    "device_shared_agent_count_30d",
    "distinct_devices_used_30d",
)

FEATURE_SETS: Dict[str, Tuple[str, ...]] = {
    "t0": T0_FEATURES,
    "t7": T0_FEATURES + T7_FEATURES,
    "t7_no_agent_history": tuple(
        name for name in T0_FEATURES + T7_FEATURES if name not in AGENT_HISTORY_FEATURES
    ),
    "t0_no_agent_history": tuple(name for name in T0_FEATURES if name not in AGENT_HISTORY_FEATURES),
}


class StaleDataError(RuntimeError):
    """Raised when the dataset on disk was generated from a different generator config."""


@dataclass(frozen=True)
class Dataset:
    keys: pd.DataFrame
    features: pd.DataFrame
    labels: np.ndarray
    typology: np.ndarray
    honesty_type: np.ndarray
    mode: np.ndarray | None = None  # generator behaviour profile; evaluation breakdowns only

    def matrix(self, feature_set: str) -> pd.DataFrame:
        return self.features[list(FEATURE_SETS[feature_set])]


def check_provenance(manifest_path: Path = RUN_MANIFEST) -> Dict[str, object]:
    """The data must come from the generator config currently on disk."""
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    current = config_module.config_hash([config_module.GENERATOR_CONFIG])
    if manifest.get("generator_config_hash") != current:
        raise StaleDataError(
            "data/ was generated from a different config/generator.yaml; "
            "rerun python -m src.generator.run"
        )
    return manifest


def load_dataset(data_dir: Path = DATA_DIR) -> Dataset:
    features = pd.read_parquet(data_dir / "features.parquet")
    internal = pd.read_parquet(data_dir / "internal_labels.parquet")
    aligned = internal.set_index("activation_id").reindex(features["activation_id"])
    if aligned["is_fraudulent"].isna().any():
        raise ValueError("internal labels do not cover every feature row")
    return Dataset(
        keys=features[list(KEY_COLUMNS)].reset_index(drop=True),
        features=features[list(T0_FEATURES + T7_FEATURES)].reset_index(drop=True),
        labels=aligned["is_fraudulent"].to_numpy().astype(int),
        typology=aligned["fraud_typology"].to_numpy().astype(str),
        honesty_type=aligned["honesty_type"].to_numpy().astype(str),
        mode=aligned["mode"].to_numpy().astype(str),
    )
