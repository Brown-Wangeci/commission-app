"""Realised prevalence and composition across seeds.

Usage: python -m src.eval.seeds
Generates each dataset in memory only; data/ is not touched.
"""

from __future__ import annotations

import copy
from typing import Any, Dict

import pandas as pd

from ..generator import config as config_module
from ..generator.run import generate
from ..generator.typologies import FRAUD_TYPOLOGIES
from . import checks
from .report import aligned_labels

OUTPUT_DIR = config_module.REPO_ROOT / "outputs"


def seed_row(cfg: Dict[str, Any], model_cfg: Dict[str, Any], seed: int) -> Dict[str, Any]:
    seeded = copy.deepcopy(cfg)
    seeded["seed"] = seed
    _, internal, features, manifest = generate(write=False, cfg=seeded)
    summary = manifest["summary"]
    labels = aligned_labels(internal.labels, features.keys)
    floor = checks.prevalence_floor(labels, features.keys["timestamp_submitted"], seeded, model_cfg)
    row: Dict[str, Any] = {"seed": seed, "activations": summary["num_activations"]}
    row |= {f"agents_{k}": v for k, v in summary["agent_type_counts"].items()}
    row["fraud_records"] = int(internal.labels["is_fraudulent"].sum())
    row["realised_fraud_rate"] = summary["realised_fraud_rate"]
    row |= {f"fraud_{t}": summary["typology_counts"].get(t, 0) for t in FRAUD_TYPOLOGIES}
    row["careful_fraud_share"] = summary["careful_fraud_count"] / max(row["fraud_records"], 1)
    row["ambiguous_share"] = summary["ambiguous_share"]
    row |= {k: v for k, v in floor.items() if k != "realised_fraud_rate"}
    return row


def prevalence_by_seed(cfg: Dict[str, Any], model_cfg: Dict[str, Any]) -> pd.DataFrame:
    seeds = [int(s) for s in cfg["diagnostics"]["robustness_seeds"]]
    return pd.DataFrame([seed_row(cfg, model_cfg, seed) for seed in seeds])


def main() -> None:
    cfg = config_module.load_config(config_module.GENERATOR_CONFIG)
    model_cfg = config_module.load_config(config_module.MODEL_CONFIG)
    table = prevalence_by_seed(cfg, model_cfg)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    table.to_csv(OUTPUT_DIR / "prevalence_by_seed.csv", index=False, float_format="%.6g")
    pd.set_option("display.width", 250)
    pd.set_option("display.max_columns", 30)
    print(table.T.to_string())


if __name__ == "__main__":
    main()
