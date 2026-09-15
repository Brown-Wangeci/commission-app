"""Entry point: generate the dataset and write a run manifest.

Usage: python -m src.generator.run
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

import numpy as np

from . import config as config_module
from .activity import simulate
from .features import T0_FEATURES, T7_FEATURES, build_features
from .population import build_population
from .schema import InternalState, ObservableLog

DATA_DIR = config_module.REPO_ROOT / "data"
OUTPUT_DIR = config_module.REPO_ROOT / "outputs"


def _summarise(
    observable: ObservableLog, internal: InternalState, features
) -> Dict[str, Any]:
    labels = internal.labels
    activations = observable.activations
    ambiguous = int(labels["is_ambiguous"].sum())
    return {
        "num_activations": int(len(activations)),
        "num_agents": int(activations["agent_id"].nunique()),
        "num_activity_rows": int(len(observable.activity)),
        "num_customers_used": int(activations["customer_msisdn_hash"].nunique()),
        "num_devices": int(activations["device_id"].nunique()),
        "first_submission": str(activations["timestamp_submitted"].min()),
        "last_submission": str(activations["timestamp_submitted"].max()),
        "realised_fraud_rate": float(labels["is_fraudulent"].mean()),
        "agent_type_counts": _agent_type_counts(internal),
        "typology_counts": {
            str(key): int(value)
            for key, value in labels["fraud_typology"].value_counts().items()
        },
        "mode_counts": {
            str(key): int(value) for key, value in labels["mode"].value_counts().items()
        },
        "honesty_type_activation_counts": {
            str(key): int(value)
            for key, value in labels["honesty_type"].value_counts().items()
        },
        "careful_fraud_count": int(labels["careful"].sum()),
        "ambiguous_count": ambiguous,
        "ambiguous_share": float(ambiguous / len(labels)),
        "num_t0_features": len(T0_FEATURES),
        "num_t7_features": len(T7_FEATURES),
    }


def _agent_type_counts(internal: InternalState) -> Dict[str, int]:
    agents = internal.labels.groupby("agent_id")["honesty_type"].first()
    return {str(key): int(value) for key, value in agents.value_counts().items()}


def generate(
    write: bool = True, cfg: Dict[str, Any] | None = None
) -> tuple[ObservableLog, InternalState, Any, Dict[str, Any]]:
    if cfg is None:
        cfg = config_module.load_config(config_module.GENERATOR_CONFIG)
    seed = int(cfg["seed"])
    rng = np.random.default_rng(seed)

    population = build_population(cfg, rng)
    observable, internal = simulate(cfg, population, rng)
    features = build_features(observable, cfg)

    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "seed": seed,
        "config_hash": config_module.config_hash(
            [config_module.GENERATOR_CONFIG, config_module.MODEL_CONFIG]
        ),
        "generator_config_hash": config_module.config_hash([config_module.GENERATOR_CONFIG]),
        "config_files": ["config/generator.yaml", "config/model.yaml"],
        "package_versions": config_module.package_versions(["numpy", "pandas", "pyarrow"]),
        "t0_features": list(T0_FEATURES),
        "t7_features": list(T7_FEATURES),
        "summary": _summarise(observable, internal, features),
    }

    if write:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        observable.activations.to_parquet(DATA_DIR / "activations.parquet", index=False)
        observable.activity.to_parquet(DATA_DIR / "activity_log.parquet", index=False)
        observable.agents.to_parquet(DATA_DIR / "agents.parquet", index=False)
        observable.payout_calendar.to_parquet(DATA_DIR / "payout_calendar.parquet", index=False)
        internal.labels.to_parquet(DATA_DIR / "internal_labels.parquet", index=False)
        features.combined().to_parquet(DATA_DIR / "features.parquet", index=False)
        (OUTPUT_DIR / "run_manifest.json").write_text(
            json.dumps(manifest, indent=2), encoding="utf-8"
        )
    return observable, internal, features, manifest


def main() -> None:
    _, _, _, manifest = generate(write=True)
    print(json.dumps(manifest["summary"], indent=2))


if __name__ == "__main__":
    main()
