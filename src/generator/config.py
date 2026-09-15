"""Configuration loading and hashing."""

from __future__ import annotations

import hashlib
import platform
from importlib import metadata
from pathlib import Path
from typing import Any, Dict, Iterable

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
GENERATOR_CONFIG = REPO_ROOT / "config" / "generator.yaml"
MODEL_CONFIG = REPO_ROOT / "config" / "model.yaml"


def load_config(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def config_hash(paths: Iterable[Path]) -> str:
    """Stable SHA-256 over the given config files.

    Line endings are normalised to LF first, so a Windows checkout that turns
    LF into CRLF still matches the hash recorded in the committed manifests.
    """
    digest = hashlib.sha256()
    for path in sorted(paths, key=lambda p: p.name):
        digest.update(path.name.encode("utf-8"))
        digest.update(path.read_bytes().replace(b"\r\n", b"\n"))
    return digest.hexdigest()


def package_versions(distributions: Iterable[str]) -> Dict[str, str]:
    """Interpreter and installed distribution versions, for run manifests."""
    versions = {"python": platform.python_version()}
    for name in distributions:
        versions[name] = metadata.version(name)
    return versions
