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


def test_every_committed_manifest_was_built_from_the_current_generator_config() -> None:
    """The data-to-model link must never go stale, whatever else changes.

    Model config is deliberately not checked here: config/model.yaml grows each
    phase, so an older run's manifest is expected to record an older model hash.
    Requiring equality would force a rerun of every historical artifact every
    time a new section is added. The generator hash is the one that matters,
    because it binds the dataset the models were trained on.
    """
    outputs = config_module.REPO_ROOT / "outputs"
    generator_hash = config_module.config_hash([config_module.GENERATOR_CONFIG])
    for name in ("run_manifest", "training_manifest", "multiseed_manifest"):
        manifest = json.loads((outputs / f"{name}.json").read_text(encoding="utf-8"))
        assert manifest["generator_config_hash"] == generator_hash, name


def test_the_current_phase_manifest_matches_both_configs_on_disk() -> None:
    outputs = config_module.REPO_ROOT / "outputs"
    manifest = json.loads((outputs / "multiseed_manifest.json").read_text(encoding="utf-8"))
    assert manifest["generator_config_hash"] == config_module.config_hash([config_module.GENERATOR_CONFIG])
    assert manifest["model_config_hash"] == config_module.config_hash([config_module.MODEL_CONFIG])
