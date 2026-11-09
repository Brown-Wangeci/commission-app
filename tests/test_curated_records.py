"""Regression test on five hand-picked real activations.

Each record in tests/fixtures/curated_records.json is one behaviour of the
service worth protecting: a clean release, a caught fraud, a decision revised
between submission and hold-close, a known miss, and a fairness-gap hold. The
test asserts the service still assigns the band recorded in the fixture at
each decision point. Payloads are rebuilt from data/ on disk, so this needs the
generated seed-42 dataset and both built artifacts, like tests/test_serve.py.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

import pandas as pd
import pytest

from src.generator import config as config_module
from src.serve import storage as storage_module
from src.serve import testing as serve_testing
from src.serve.service import ScoringService

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "curated_records.json"
GEN_CFG = config_module.load_config(config_module.GENERATOR_CONFIG)
HISTORY_DAYS = int(GEN_CFG["features"]["msisdn_history_days"])
MODES = ("t0", "t7")


FIXTURE = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
RECORDS: List[Dict[str, Any]] = FIXTURE["records"]
RUN_MANIFEST = config_module.REPO_ROOT / "outputs" / "run_manifest.json"


def _mismatch_message(what: str, found: str) -> str:
    return (
        f"{what} has generator config hash {found}, but tests/fixtures/curated_records.json "
        f"was recorded against {FIXTURE['source']['generator_config_hash']} "
        f"(seed {FIXTURE['source']['seed']}). These records only exist in that exact "
        "generation. Regenerate with `python -m src.generator.run` from the matching "
        "config/generator.yaml, or, if the generator was changed on purpose, choose new "
        "records and re-record the fixture."
    )


@pytest.fixture(scope="module", autouse=True)
def data_is_the_recorded_generation():
    """Fail with one clear message, before any band assertion, if data/ came
    from a different generator config than the one the records were picked
    from. The manifest is rewritten by every `python -m src.generator.run`, so
    it describes the data currently on disk."""
    expected = FIXTURE["source"]["generator_config_hash"]
    on_disk = json.loads(RUN_MANIFEST.read_text(encoding="utf-8"))["generator_config_hash"]
    assert on_disk == expected, _mismatch_message("the data in data/ (outputs/run_manifest.json)", on_disk)
    current = config_module.config_hash([config_module.GENERATOR_CONFIG])
    assert current == expected, _mismatch_message("config/generator.yaml", current)


@pytest.fixture(scope="module")
def frames():
    return serve_testing.load_frames()


@pytest.fixture(scope="module")
def service(tmp_path_factory):
    db_path = tmp_path_factory.mktemp("curated") / "predictions.db"
    return ScoringService(db=storage_module.Storage(db_path))


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("record", RECORDS, ids=lambda r: r["activation_id"])
def test_service_assigns_the_recorded_band(record, mode, service, frames):
    payload = serve_testing.build_request_payload(
        record["activation_id"], frames, HISTORY_DAYS, mode=mode
    )
    scored = service.score(
        mode=mode,
        activation=payload["activation"],
        agents=payload["agents"],
        recent_activations=payload["recent_activations"],
        payout_calendar=payload["payout_calendar"],
        downstream_activity=payload["downstream_activity"],
        persist=False,
    )
    assert scored.band == record["expected_band"][mode]


def test_fixture_labels_match_the_generated_dataset():
    """The stored true labels must be what the generator actually wrote, so a
    regenerated dataset with different activations under the same ids fails
    here rather than silently changing what the bands above mean."""
    labels = pd.read_parquet(serve_testing.DATA_DIR / "internal_labels.parquet")
    labels = labels.set_index("activation_id")
    for record in RECORDS:
        row = labels.loc[record["activation_id"]]
        assert bool(row["is_fraudulent"]) == record["is_fraudulent"], record["activation_id"]
        assert row["fraud_typology"] == record["fraud_typology"], record["activation_id"]
        assert row["honesty_type"] == record["honesty_type"], record["activation_id"]
        assert row["agent_id"] == record["agent_id"], record["activation_id"]


def test_the_fixture_still_exercises_a_revised_decision():
    """At least one record must change band between the two decision points,
    otherwise the fixture has lost the case it exists to protect."""
    revised = [r for r in RECORDS if r["expected_band"]["t0"] != r["expected_band"]["t7"]]
    assert revised
