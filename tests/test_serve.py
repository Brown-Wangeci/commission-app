"""Tests for the inference service.

B2: the service must compute the same feature vector as the training
pipeline for the same input -- this is the test that fails if someone
reimplements a feature instead of importing build_features.
E2 (Phase 7): the service must assign the same band as the offline pipeline.
A5 (Phase 8): no calibrated probability is ever exactly 0 or 1.
B3/B6 (Phase 8): mode dispatch, and T0 reasons only ever reference T0 features.
"""

from __future__ import annotations

import numpy as np
import pytest
from fastapi.testclient import TestClient

from src.generator import config as config_module
from src.generator.features import T0_FEATURES, T7_FEATURES
from src.serve import artifact as artifact_module
from src.serve import observable as observable_module
from src.serve import reasons as reasons_module
from src.serve import settings as settings_module
from src.serve import storage as storage_module
from src.serve import testing as serve_testing
from src.serve.app import app
from src.serve.service import ScoringService
from src.train import data as data_module

GEN_CFG = config_module.load_config(config_module.GENERATOR_CONFIG)
MODEL_CFG = config_module.load_config(config_module.MODEL_CONFIG)
HISTORY_DAYS = int(GEN_CFG["features"]["msisdn_history_days"])
SAMPLE_COUNT = 20


@pytest.fixture(scope="module", autouse=True)
def clean_prediction_db():
    """The API-level tests below use TestClient(app), which points at the
    real db_path in config/serving.yaml (not a per-test tmp file), since
    that is the file a real deployment would write to. Start each test run
    from an empty file so records left over from a previous run cannot be
    mistaken for records this run created."""
    path = settings_module.db_path()
    if path.exists():
        path.unlink()
    yield


@pytest.fixture(scope="module")
def frames():
    return serve_testing.load_frames()


@pytest.fixture(scope="module")
def dataset():
    return data_module.load_dataset()


@pytest.fixture(scope="module")
def t7_artifact():
    return artifact_module.load_artifact()


@pytest.fixture(scope="module")
def t0_artifact():
    cfg = artifact_module.settings.load_serving_config()
    return artifact_module.load_artifact(str(cfg["t0_model_version"]), cfg)


@pytest.fixture(scope="module")
def sample_activation_ids(t7_artifact, dataset):
    calibration_index = serve_testing.held_out_calibration_index(dataset, MODEL_CFG)
    return serve_testing.select_smoke_test_ids(t7_artifact, dataset, calibration_index, SAMPLE_COUNT)


@pytest.fixture(scope="module")
def service(tmp_path_factory):
    db_path = tmp_path_factory.mktemp("serve") / "predictions.db"
    return ScoringService(db=storage_module.Storage(db_path))


# --- reason phrase coverage (Part D, B6) ---------------------------------

def test_reason_phrases_cover_every_feature_of_both_artifacts(t7_artifact, t0_artifact):
    for artifact in (t7_artifact, t0_artifact):
        phrases = reasons_module.load_phrases(artifact.features)
        assert set(artifact.features) <= set(phrases)


def test_reason_phrases_file_covers_the_full_t0_and_t7_sets():
    phrases = reasons_module.load_phrases(T0_FEATURES + T7_FEATURES)
    assert set(T0_FEATURES + T7_FEATURES) <= set(phrases)


def test_t0_artifact_features_are_a_subset_of_t0_features(t0_artifact):
    """The T0 model must only ever be able to explain itself using T0
    features -- there is no T7 column for it to reach for."""
    assert set(t0_artifact.features) <= set(T0_FEATURES)
    assert set(t0_artifact.features).isdisjoint(T7_FEATURES)


# --- B2: feature-vector equivalence with the training pipeline ----------

@pytest.mark.parametrize("index", range(SAMPLE_COUNT))
def test_service_feature_vector_matches_training_pipeline(
    index, sample_activation_ids, frames, dataset
):
    if index >= len(sample_activation_ids):
        pytest.skip("fewer held-out ids than requested")
    activation_id = sample_activation_ids[index]
    payload = serve_testing.build_request_payload(activation_id, frames, HISTORY_DAYS, mode="t7")

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
    payload = serve_testing.build_request_payload(activation_id, frames, HISTORY_DAYS, mode="t7")
    row = observable_module.score_row_features(
        payload["activation"], payload["recent_activations"], payload["agents"],
        payload["payout_calendar"], payload["downstream_activity"], GEN_CFG,
    )
    position = serve_testing.position_of(dataset.keys, activation_id)
    wrong = float(dataset.features.iloc[position]["agent_tenure_days"]) + 1000.0
    assert float(row["agent_tenure_days"]) != pytest.approx(wrong, abs=1e-6)


def test_t0_mode_computes_without_a_downstream_log(frames, dataset):
    """mode="t0" must produce the same T0 columns as the training pipeline
    even though no downstream_activity is supplied."""
    activation_id = frames["activations"].iloc[50]["activation_id"]
    payload = serve_testing.build_request_payload(activation_id, frames, HISTORY_DAYS, mode="t0")
    assert payload["downstream_activity"] == []

    row = observable_module.score_row_features(
        payload["activation"], payload["recent_activations"], payload["agents"],
        payload["payout_calendar"], payload["downstream_activity"], GEN_CFG,
    )
    position = serve_testing.position_of(dataset.keys, activation_id)
    expected = dataset.features.iloc[position]
    for feature in T0_FEATURES:
        assert float(row[feature]) == pytest.approx(float(expected[feature]), abs=1e-6), feature


# --- E2 (Phase 7) / A4 (Phase 8): band agreement with the offline pipeline

def test_service_assigns_the_same_band_as_the_offline_pipeline(
    service, sample_activation_ids, frames, dataset
):
    for activation_id in sample_activation_ids:
        payload = serve_testing.build_request_payload(activation_id, frames, HISTORY_DAYS, mode="t7")
        scored = service.score(
            mode="t7",
            activation=payload["activation"],
            agents=payload["agents"],
            recent_activations=payload["recent_activations"],
            payout_calendar=payload["payout_calendar"],
            downstream_activity=payload["downstream_activity"],
            persist=False,
        )

        artifact = service.artifacts["t7"]
        position = serve_testing.position_of(dataset.keys, activation_id)
        offline_row = dataset.features[list(artifact.features)].iloc[[position]]
        offline_raw = float(artifact.booster.predict_proba(offline_row)[0, 1])
        # Same wrapper the service itself uses (Part A1): offline and served
        # predictions must clip identically.
        offline_probability = float(artifact.calibrate([offline_raw])[0])
        offline_band = artifact.assign_band(offline_probability)

        assert scored.raw_score == pytest.approx(offline_raw, abs=1e-6)
        assert scored.calibrated_probability == pytest.approx(offline_probability, abs=1e-6)
        assert scored.band == offline_band


def test_all_three_bands_are_represented_in_the_sample(sample_activation_ids, frames, dataset, service):
    bands = set()
    for activation_id in sample_activation_ids:
        payload = serve_testing.build_request_payload(activation_id, frames, HISTORY_DAYS, mode="t7")
        scored = service.score(
            mode="t7", activation=payload["activation"], agents=payload["agents"],
            recent_activations=payload["recent_activations"],
            payout_calendar=payload["payout_calendar"],
            downstream_activity=payload["downstream_activity"], persist=False,
        )
        bands.add(scored.band)
    assert bands == {"auto_release", "review", "reject"}


# --- A: clipped calibrated probabilities ---------------------------------

def test_calibrated_probability_is_never_exactly_zero_or_one(t7_artifact, t0_artifact, dataset):
    for artifact in (t7_artifact, t0_artifact):
        matrix = dataset.features[list(artifact.features)]
        raw = artifact.booster.predict_proba(matrix)[:, 1]
        probability = artifact.calibrate(raw)
        assert (probability > 0.0).all()
        assert (probability < 1.0).all()
        assert probability.min() >= artifact.probability_clip[0]
        assert probability.max() <= artifact.probability_clip[1]


def test_the_unclipped_calibrator_actually_does_saturate(t7_artifact, dataset):
    """Negative control: prove clipping is doing something, not asserting a
    vacuous truth. Without the wrapper, this calibrator really does emit
    exact 0.0 / 1.0 on this data."""
    matrix = dataset.features[list(t7_artifact.features)]
    raw = t7_artifact.booster.predict_proba(matrix)[:, 1]
    unclipped = np.asarray(t7_artifact.calibrator.predict(raw), dtype=float)
    assert (unclipped == 0.0).any() or (unclipped == 1.0).any()


def test_clipping_does_not_change_the_chosen_band_assignments(
    service, sample_activation_ids, frames
):
    """A4: both thresholds sit well inside [0.001, 0.999], so clipping must
    not move any of the twenty smoke-test records to a different band."""
    for mode in ("t0", "t7"):
        artifact = service.artifacts[mode]
        assert artifact.probability_clip[0] < artifact.release_threshold
        assert artifact.probability_clip[1] > artifact.reject_threshold

    for activation_id in sample_activation_ids:
        for mode in ("t0", "t7"):
            payload = serve_testing.build_request_payload(activation_id, frames, HISTORY_DAYS, mode=mode)
            scored = service.score(
                mode=mode, activation=payload["activation"], agents=payload["agents"],
                recent_activations=payload["recent_activations"],
                payout_calendar=payload["payout_calendar"],
                downstream_activity=payload["downstream_activity"], persist=False,
            )
            artifact = service.artifacts[mode]
            unclipped = float(artifact.calibrator.predict([scored.raw_score])[0])
            assert artifact.assign_band(unclipped) == scored.band


# --- API-level tests ------------------------------------------------------

def test_health_reports_both_model_versions():
    with TestClient(app) as client:
        response = client.get("/health")
        assert response.status_code == 200
        body = response.json()
        assert body["loaded"] is True
        assert body["model_version"]
        assert body["t0_model_version"]
        assert body["model_version"] != body["t0_model_version"]


def test_score_rejects_malformed_request():
    with TestClient(app) as client:
        response = client.post("/score", json={"mode": "t7", "activation": {"activation_id": "x"}})
        assert response.status_code == 422


def test_score_requires_mode(frames):
    activation_id = frames["activations"].iloc[0]["activation_id"]
    payload = serve_testing.build_request_payload(activation_id, frames, HISTORY_DAYS, mode="t7")
    del payload["mode"]
    with TestClient(app) as client:
        response = client.post("/score", json=payload)
        assert response.status_code == 422


def test_score_rejects_unknown_extra_field(frames):
    activation_id = frames["activations"].iloc[0]["activation_id"]
    payload = serve_testing.build_request_payload(activation_id, frames, HISTORY_DAYS, mode="t7")
    payload["activation"]["not_a_real_field"] = 1
    with TestClient(app) as client:
        response = client.post("/score", json=payload)
        assert response.status_code == 422


def test_score_rejects_agent_missing_from_agents_list(frames):
    activation_id = frames["activations"].iloc[0]["activation_id"]
    payload = serve_testing.build_request_payload(activation_id, frames, HISTORY_DAYS, mode="t7")
    payload["agents"] = [a for a in payload["agents"] if a["agent_id"] != payload["activation"]["agent_id"]]
    with TestClient(app) as client:
        response = client.post("/score", json=payload)
        assert response.status_code == 422


def test_score_rejects_t0_mode_with_downstream_activity(frames):
    """B3: mode="t0" must reject a request that includes downstream_activity."""
    activation_id = frames["activations"].iloc[0]["activation_id"]
    payload = serve_testing.build_request_payload(activation_id, frames, HISTORY_DAYS, mode="t7")
    payload["mode"] = "t0"  # downstream_activity from the t7 build is still attached
    assert payload["downstream_activity"]
    with TestClient(app) as client:
        response = client.post("/score", json=payload)
        assert response.status_code == 422


def test_score_rejects_t7_mode_without_downstream_activity(frames):
    activation_id = frames["activations"].iloc[0]["activation_id"]
    payload = serve_testing.build_request_payload(activation_id, frames, HISTORY_DAYS, mode="t0")
    payload["mode"] = "t7"  # no downstream_activity attached
    with TestClient(app) as client:
        response = client.post("/score", json=payload)
        assert response.status_code == 422


def test_score_t0_mode_succeeds_with_only_submission_time_data(frames):
    activation_id = frames["activations"].iloc[0]["activation_id"]
    payload = serve_testing.build_request_payload(activation_id, frames, HISTORY_DAYS, mode="t0")
    with TestClient(app) as client:
        response = client.post("/score", json=payload)
        assert response.status_code == 200
        body = response.json()
        assert body["mode"] == "t0"
        assert body["feature_set"] == "t0"


@pytest.mark.parametrize("mode", ["t0", "t7"])
def test_score_returns_the_full_feature_vector_it_scored(frames, dataset, mode):
    """The response carries every feature the model scored (app issue #43),
    and each value is the training pipeline's own value for that activation."""
    features = data_module.FEATURE_SETS[mode]
    activation_id = frames["activations"].iloc[50]["activation_id"]
    payload = serve_testing.build_request_payload(activation_id, frames, HISTORY_DAYS, mode=mode)
    with TestClient(app) as client:
        response = client.post("/score", json=payload)
    assert response.status_code == 200
    vector = response.json()["feature_vector"]
    assert sorted(vector) == sorted(features)
    expected = dataset.features.iloc[serve_testing.position_of(dataset.keys, activation_id)]
    for feature in features:
        assert vector[feature] == pytest.approx(float(expected[feature]), abs=1e-6), feature


def test_score_t0_reasons_only_reference_t0_features(frames):
    activation_id = frames["activations"].iloc[0]["activation_id"]
    payload = serve_testing.build_request_payload(activation_id, frames, HISTORY_DAYS, mode="t0")
    with TestClient(app) as client:
        response = client.post("/score", json=payload)
        assert response.status_code == 200
        for reason in response.json()["top_reasons"]:
            assert reason["feature"] in T0_FEATURES
            assert reason["feature"] not in T7_FEATURES


def test_score_then_explain_returns_both_records_in_time_order(frames):
    """B5: scoring an activation in both modes must leave two records,
    oldest first, so the dispute flow can see a decision being revised.

    Uses an activation_id no other test in this module touches (the others
    all use index 0), so the exact record count is not affected by test
    order within the shared, file-backed prediction db that TestClient(app)
    writes to.
    """
    activation_id = frames["activations"].iloc[1]["activation_id"]
    with TestClient(app) as client:
        t0_payload = serve_testing.build_request_payload(activation_id, frames, HISTORY_DAYS, mode="t0")
        t0_response = client.post("/score", json=t0_payload)
        assert t0_response.status_code == 200

        t7_payload = serve_testing.build_request_payload(activation_id, frames, HISTORY_DAYS, mode="t7")
        t7_response = client.post("/score", json=t7_payload)
        assert t7_response.status_code == 200

        explained = client.get(f"/explain/{activation_id}")
        assert explained.status_code == 200
        body = explained.json()
        assert body["activation_id"] == activation_id
        assert len(body["records"]) == 2
        assert body["records"][0]["mode"] == "t0"
        assert body["records"][1]["mode"] == "t7"
        assert body["records"][0]["scored_at"] <= body["records"][1]["scored_at"]
        assert body["records"][0]["calibrated_probability"] == pytest.approx(
            t0_response.json()["calibrated_probability"]
        )
        assert body["records"][1]["calibrated_probability"] == pytest.approx(
            t7_response.json()["calibrated_probability"]
        )


def test_explain_unknown_activation_is_404():
    with TestClient(app) as client:
        response = client.get("/explain/no-such-activation")
        assert response.status_code == 404


def test_reason_strings_never_show_a_raw_feature_name(frames):
    activation_id = frames["activations"].iloc[0]["activation_id"]
    payload = serve_testing.build_request_payload(activation_id, frames, HISTORY_DAYS, mode="t7")
    with TestClient(app) as client:
        response = client.post("/score", json=payload)
        assert response.status_code == 200
        for reason in response.json()["top_reasons"]:
            assert "_" not in reason["description"], reason["description"]
