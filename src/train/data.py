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

FEATURE_SETS: Dict[str, Tuple[str, ...]] = {
    "t0": T0_FEATURES,
    "t7": T0_FEATURES + T7_FEATURES,
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
