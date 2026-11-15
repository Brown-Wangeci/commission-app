"""The hosted scoring service serves the published artifacts, never a rebuild.

These check the wiring only. They do not recompute the archive's SHA-256:
CI builds its own artifacts, which is exactly what the release avoids, so
they would not match. `python scripts/package_artifacts.py --check` does that
against local artifacts.
"""

import re
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
CHECKSUM = REPO_ROOT / "artifacts" / "scoring-artifacts-v1.tar.gz.sha256"
ARCHIVE = "scoring-artifacts-v1.tar.gz"


def build_command() -> str:
    services = yaml.safe_load((REPO_ROOT / "render.yaml").read_text(encoding="utf-8"))["services"]
    return str(services[0]["buildCommand"])


def test_checksum_file_is_in_sha256sum_format() -> None:
    text = CHECKSUM.read_text(encoding="utf-8")
    assert re.fullmatch(r"[0-9a-f]{64}  " + re.escape(ARCHIVE) + r"\n", text)


def test_render_build_downloads_and_verifies_the_release() -> None:
    command = build_command()
    assert f"releases/download/scoring-artifacts-v1/{ARCHIVE}" in command
    assert "sha256sum -c artifacts/scoring-artifacts-v1.tar.gz.sha256" in command
    assert command.index("sha256sum -c") < command.index("tar -xzf")
    assert "||" not in command and ";" not in command, "a failed check must stop the build"


def test_render_build_does_not_retrain() -> None:
    command = build_command()
    assert "src.generator.run" not in command
    assert "src.serve.artifact" not in command
