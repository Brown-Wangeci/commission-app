"""Loading config/serving.yaml. No serving parameter is hardcoded elsewhere."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict

from ..generator import config as config_module

SERVING_CONFIG = config_module.REPO_ROOT / "config" / "serving.yaml"


def load_serving_config() -> Dict[str, Any]:
    return config_module.load_config(SERVING_CONFIG)


def artifact_dir(cfg: Dict[str, Any] | None = None) -> Path:
    cfg = cfg or load_serving_config()
    path = config_module.REPO_ROOT / cfg["artifact_dir"]
    path.mkdir(parents=True, exist_ok=True)
    return path


def db_path(cfg: Dict[str, Any] | None = None) -> Path:
    cfg = cfg or load_serving_config()
    path = config_module.REPO_ROOT / cfg["db_path"]
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def reason_phrases_path(cfg: Dict[str, Any] | None = None) -> Path:
    cfg = cfg or load_serving_config()
    return config_module.REPO_ROOT / cfg["reason_phrases_path"]
