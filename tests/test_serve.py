"""Tests for the inference service.

B2: the service must compute the same feature vector as the training
pipeline for the same input -- this is the test that fails if someone
reimplements a feature instead of importing build_features.
E2: the service must assign the same band as the offline pipeline.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from src.generator import config as config_module
from src.serve import artifact as artifact_module
from src.serve import observable as observable_module
from src.serve import reasons as reasons_module
from src.serve import storage as storage_module
from src.serve import testing as serve_testing
from src.serve.app import app
from src.serve.service import ScoringService
from src.train import data as data_module

GEN_CFG = config_module.load_config(config_module.GENERATOR_CONFIG)
MODEL_CFG = config_module.load_config(config_module.MODEL_CONFIG)
HISTORY_DAYS = int(GEN_CFG["features"]["msisdn_history_days"])
SAMPLE_COUNT = 20


@pytest.fixture(scope="module")
def frames():
    return serve_testing.load_frames()


@pytest.fixture(scope="module")
def dataset():
    return data_module.load_dataset()


@pytest.fixture(scope="module")
def artifact():
    return artifact_module.load_artifact()


@pytest.fixture(scope="module")
def sample_activation_ids(artifact, dataset):
    calibration_index = serve_testing.held_out_calibration_index(dataset, MODEL_CFG)
    return serve_testing.select_smoke_test_ids(artifact, dataset, calibration_index, SAMPLE_COUNT)


@pytest.fixture(scope="module")
def service(tmp_path_factory):
    db_path = tmp_path_factory.mktemp("serve") / "predictions.db"
    return ScoringService(db=storage_module.Storage(db_path))


def test_reason_phrases_cover_every_feature(artifact):
    phrases = reasons_module.load_phrases(artifact.features)
    assert set(artifact.features) <= set(phrases)


def test_reason_phrases_file_covers_the_full_t0_and_t7_sets():
    from src.generator.features import T0_FEATURES, T7_FEATURES

    phrases = reasons_module.load_phrases(T0_FEATURES + T7_FEATURES)
    assert set(T0_FEATURES + T7_FEATURES) <= set(phrases)


@pytest.mark.parametrize("index", range(SAMPLE_COUNT))
def test_service_feature_vector_matches_training_pipeline(
    index, sample_activation_ids, frames, dataset
):
    if index >= len(sample_activation_ids):
        pytest.skip("fewer held-out ids than requested")
    activation_id = sample_activation_ids[index]
    payload = serve_testing.build_request_payload(activation_id, frames, HISTORY_DAYS)

    row = observable_module.score_row_features(
        payload["activation"], payload["recent_activations"], payload["agents"],
        payload["payout_calendar"], payload["downstream_activity"], GEN_CFG,
    )

    position = serve_testing.position_of(dataset.keys, activation_id)
    expected = dataset.features.iloc[position]
    for feature in data_module.FEATURE_SETS["t7"]:
        assert float(row[feature]) == pytest.approx(float(expected[feature]), abs=1e-6), feature


def test_a_reimplemented_feature_would_be_caught(frames, dataset):
    """Guard against the test above passing by accident: corrupting one
    feature's expected value must make the comparison fail, proving the
    assertion is actually discriminating."""
    activation_id = frames["activations"].iloc[0]["activation_id"]
    payload = serve_testing.build_request_payload(activation_id, frames, HISTORY_DAYS)
    row = observable_module.score_row_features(
        payload["activation"], payload["recent_activations"], payload["agents"],
        payload["payout_calendar"], payload["downstream_activity"], GEN_CFG,
    )
    position = serve_testing.position_of(dataset.keys, activation_id)
    wrong = float(dataset.features.iloc[position]["agent_tenure_days"]) + 1000.0
    assert float(row["agent_tenure_days"]) != pytest.approx(wrong, abs=1e-6)


def test_service_assigns_the_same_band_as_the_offline_pipeline(
    service, sample_activation_ids, frames, dataset
):
    for activation_id in sample_activation_ids:
        payload = serve_testing.build_request_payload(activation_id, frames, HISTORY_DAYS)
        scored = service.score(
            activation=payload["activation"],
            agents=payload["agents"],
            recent_activations=payload["recent_activations"],
            payout_calendar=payload["payout_calendar"],
            downstream_activity=payload["downstream_activity"],
            persist=False,
        )

        position = serve_testing.position_of(dataset.keys, activation_id)
        offline_row = dataset.features[list(service.artifact.features)].iloc[[position]]
        offline_raw = float(service.artifact.booster.predict_proba(offline_row)[0, 1])
        offline_probability = float(service.artifact.calibrator.predict([offline_raw])[0])
        offline_band = service.assign_band(offline_probability)

        assert scored.raw_score == pytest.approx(offline_raw, abs=1e-6)
        assert scored.calibrated_probability == pytest.approx(offline_probability, abs=1e-6)
        assert scored.band == offline_band


def test_all_three_bands_are_represented_in_the_sample(sample_activation_ids, frames, dataset, service):
    bands = set()
    for activation_id in sample_activation_ids:
        payload = serve_testing.build_request_payload(activation_id, frames, HISTORY_DAYS)
        scored = service.score(
            activation=payload["activation"], agents=payload["agents"],
            recent_activations=payload["recent_activations"],
            payout_calendar=payload["payout_calendar"],
            downstream_activity=payload["downstream_activity"], persist=False,
        )
        bands.add(scored.band)
    assert bands == {"auto_release", "review", "reject"}


def test_health_reports_loaded_model():
    with TestClient(app) as client:
        response = client.get("/health")
        assert response.status_code == 200
        body = response.json()
        assert body["loaded"] is True
        assert body["model_version"]


def test_score_rejects_malformed_request():
    with TestClient(app) as client:
        response = client.post("/score", json={"activation": {"activation_id": "x"}})
        assert response.status_code == 422


def test_score_rejects_unknown_extra_field(frames):
    activation_id = frames["activations"].iloc[0]["activation_id"]
    payload = serve_testing.build_request_payload(activation_id, frames, HISTORY_DAYS)
    payload["activation"]["not_a_real_field"] = 1
    with TestClient(app) as client:
        response = client.post("/score", json=payload)
        assert response.status_code == 422


def test_score_rejects_agent_missing_from_agents_list(frames):
    activation_id = frames["activations"].iloc[0]["activation_id"]
    payload = serve_testing.build_request_payload(activation_id, frames, HISTORY_DAYS)
    payload["agents"] = [a for a in payload["agents"] if a["agent_id"] != payload["activation"]["agent_id"]]
    with TestClient(app) as client:
        response = client.post("/score", json=payload)
        assert response.status_code == 422


def test_score_then_explain_round_trips(frames):
    activation_id = frames["activations"].iloc[0]["activation_id"]
    payload = serve_testing.build_request_payload(activation_id, frames, HISTORY_DAYS)
    with TestClient(app) as client:
        scored = client.post("/score", json=payload)
        assert scored.status_code == 200
        body = scored.json()

        explained = client.get(f"/explain/{activation_id}")
        assert explained.status_code == 200
        record = explained.json()
        assert record["model_version"] == body["model_version"]
        assert record["band"] == body["band"]
        assert record["calibrated_probability"] == pytest.approx(body["calibrated_probability"])
        assert len(record["top_reasons"]) == len(body["top_reasons"])


def test_explain_unknown_activation_is_404():
    with TestClient(app) as client:
        response = client.get("/explain/no-such-activation")
        assert response.status_code == 404


def test_reason_strings_never_show_a_raw_feature_name(frames):
    activation_id = frames["activations"].iloc[0]["activation_id"]
    payload = serve_testing.build_request_payload(activation_id, frames, HISTORY_DAYS)
    with TestClient(app) as client:
        response = client.post("/score", json=payload)
        assert response.status_code == 200
        for reason in response.json()["top_reasons"]:
            assert "_" not in reason["description"], reason["description"]
