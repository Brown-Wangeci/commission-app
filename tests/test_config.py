import json

from src.generator import config as config_module


def test_config_hash_ignores_line_endings(tmp_path) -> None:
    lf_dir, crlf_dir = tmp_path / "lf", tmp_path / "crlf"
    lf_dir.mkdir()
    crlf_dir.mkdir()
    (lf_dir / "generator.yaml").write_bytes(b"seed: 42\nnum_days: 180\n")
    (crlf_dir / "generator.yaml").write_bytes(b"seed: 42\r\nnum_days: 180\r\n")
    assert config_module.config_hash([lf_dir / "generator.yaml"]) == config_module.config_hash(
        [crlf_dir / "generator.yaml"]
    )


def test_config_hash_changes_when_a_value_changes(tmp_path) -> None:
    path = tmp_path / "generator.yaml"
    path.write_bytes(b"seed: 42\n")
    before = config_module.config_hash([path])
    path.write_bytes(b"seed: 43\n")
    assert config_module.config_hash([path]) != before


def test_committed_manifests_match_the_configs_on_disk() -> None:
    outputs = config_module.REPO_ROOT / "outputs"
    generator_hash = config_module.config_hash([config_module.GENERATOR_CONFIG])
    run = json.loads((outputs / "run_manifest.json").read_text(encoding="utf-8"))
    training = json.loads((outputs / "training_manifest.json").read_text(encoding="utf-8"))
    assert run["generator_config_hash"] == generator_hash
    assert training["generator_config_hash"] == generator_hash
    assert training["model_config_hash"] == config_module.config_hash([config_module.MODEL_CONFIG])
