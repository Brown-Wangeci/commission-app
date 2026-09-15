import copy
import json

import numpy as np
import pandas as pd
import pytest

from src.eval.cv import build_folds
from src.generator.features import T0_FEATURES, T7_FEATURES
from src.train import data as data_module
from src.train import models as models_module
from src.train import run as run_module
from src.train.models import rule_flags, rule_scores


@pytest.fixture(scope="module")
def small_dataset(generated) -> data_module.Dataset:
    _, _, internal, features = generated
    aligned = internal.labels.set_index("activation_id").reindex(features.keys["activation_id"])
    return data_module.Dataset(
        keys=features.keys,
        features=pd.concat([features.t0, features.t7], axis=1),
        labels=aligned["is_fraudulent"].to_numpy().astype(int),
        typology=aligned["fraud_typology"].to_numpy().astype(str),
        honesty_type=aligned["honesty_type"].to_numpy().astype(str),
    )


@pytest.fixture(scope="module")
def fast_model_config(model_config):
    fast = copy.deepcopy(model_config)
    fast["xgboost"]["search_iterations"] = 2
    fast["xgboost"]["search_space"]["n_estimators"] = {"dist": "discrete", "values": [20], "weights": [1]}
    fast["cross_validation"]["n_repeats"] = 1
    return fast


def test_t0_feature_set_contains_no_downstream_feature() -> None:
    assert set(data_module.FEATURE_SETS["t0"]).isdisjoint(T7_FEATURES)
    assert set(data_module.FEATURE_SETS["t7"]) == set(T0_FEATURES) | set(T7_FEATURES)


def test_rule_score_counts_rules_fired_without_fitting() -> None:
    features = pd.DataFrame({"a": [1.0, 5.0, 5.0], "b": [0.0, 0.0, 1.0]})
    rules = [
        {"name": "high_a", "conditions": [{"feature": "a", "op": ">=", "value": 5}]},
        {"name": "high_a_and_b", "conditions": [
            {"feature": "a", "op": ">=", "value": 5},
            {"feature": "b", "op": "==", "value": 1},
        ]},
    ]
    assert list(rule_scores(features, rules)) == [0.0, 1.0, 2.0]
    assert list(rule_flags(features, rules).columns) == ["high_a", "high_a_and_b"]


def test_configured_rules_reference_real_features(model_config) -> None:
    known = set(T0_FEATURES) | set(T7_FEATURES)
    for rule in model_config["rules_baseline"]:
        for condition in rule["conditions"]:
            assert condition["feature"] in known


def test_smote_only_ever_sees_training_rows(small_dataset, cfg, fast_model_config, monkeypatch) -> None:
    """Intercept every SMOTE call made during a real fold and check the rows it received."""
    folds = build_folds(small_dataset.keys, small_dataset.labels, cfg, fast_model_config)
    fold = folds[0]
    seen: list[np.ndarray] = []
    original = models_module.smote_resample

    def recording(features, labels, model_cfg, seed):
        seen.append(features.index.to_numpy())
        return original(features, labels, model_cfg, seed)

    monkeypatch.setattr(models_module, "smote_resample", recording)
    records = run_module.RunRecords(predictions=[], folds=[], params=[], importance=[])
    run_module._run_fold(small_dataset, fold, fast_model_config, records)

    assert seen, "SMOTE was never called"
    inner_train, outer_train, test = set(fold.inner_train_index), set(fold.train_index), set(fold.test_index)
    search_calls = [rows for rows in seen if set(rows) <= inner_train]
    refit_calls = [rows for rows in seen if set(rows) == outer_train]
    assert len(search_calls) + len(refit_calls) == len(seen)
    assert search_calls and refit_calls
    for rows in seen:
        assert set(rows).isdisjoint(test)
    for rows in search_calls:
        assert set(rows).isdisjoint(fold.inner_val_index)


def test_every_model_scores_exactly_the_test_rows(small_dataset, cfg, fast_model_config) -> None:
    fold = build_folds(small_dataset.keys, small_dataset.labels, cfg, fast_model_config)[0]
    records = run_module.RunRecords(predictions=[], folds=[], params=[], importance=[])
    run_module._run_fold(small_dataset, fold, fast_model_config, records)
    expected = set(small_dataset.keys["activation_id"].to_numpy()[fold.test_index])
    assert len(records.predictions) == len(run_module.MODEL_SPECS)
    for frame in records.predictions:
        assert set(frame["activation_id"]) == expected
        assert np.isfinite(frame["score"]).all()


def test_training_refuses_data_from_a_different_generator_config(tmp_path) -> None:
    manifest = tmp_path / "run_manifest.json"
    manifest.write_text(json.dumps({"generator_config_hash": "not-the-current-hash"}), encoding="utf-8")
    with pytest.raises(data_module.StaleDataError):
        data_module.check_provenance(manifest)
