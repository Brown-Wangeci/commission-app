"""DR-10: the exported review labels, and the retraining comparison that uses them.

The pipeline is exercised on the reduced simulation the suite already builds,
with a two-candidate search, so the whole file stays fast.
"""

from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
from typing import Any, Dict, List

import numpy as np
import pandas as pd
import pytest

from src.eval.cv import build_folds
from src.generator import config as config_module
from src.train import data as data_module
from src.train import retrain as retrain_module
from src.train import review_labels as review_module
from src.train.models import fit_xgboost

T7_FEATURES = data_module.FEATURE_SETS["t7"]


def label_row(row: int, label: int, *, group: int = 1, feature_set: str = "t7", **overrides: Any) -> Dict[str, Any]:
    """One exported row, shaped exactly as app/src/lib/labels/export.ts writes it."""
    decision = "refused" if label == 1 else "approved"
    names = data_module.FEATURE_SETS[feature_set]
    record = {
        "row": row,
        "agent_group": group,
        "mode": feature_set,
        "feature_set": feature_set,
        "model_version": f"{feature_set}_none-isotonic-v1",
        "model_probability": 0.5,
        "model_band": "review",
        "release_threshold": 0.266667,
        "reject_threshold": 0.666667,
        "scored_at": "2026-10-01T08:00:00.000Z",
        "decided_at": f"2026-10-0{row}T09:00:00.000Z",
        "decision": decision,
        "label": label,
        "reviewer_role": "admin",
        "open_reason": "band_review",
        "features": {name: float(row + index) for index, name in enumerate(names)},
    }
    record.update(overrides)
    return record


def write_export(folder: Path, records: List[Dict[str, Any]], **manifest_overrides: Any) -> Path:
    """An export folder on disk, with a manifest that matches its own bytes."""
    rows = records
    raw = "".join(json.dumps(row) + "\n" for row in rows)
    (folder).mkdir(parents=True, exist_ok=True)
    (folder / review_module.LABELS_FILENAME).write_text(raw, encoding="utf-8")
    manifest = {
        "dataset": review_module.DATASET_NAME,
        "version": folder.name,
        "exportedAt": "2026-11-25T10:00:00.000Z",
        "rows": len(rows),
        "labels": {"approved": sum(1 for row in rows if row["label"] == 0), "refused": sum(1 for row in rows if row["label"] == 1)},
        "byMode": {}, "byOpenReason": {}, "byModelVersion": {}, "agentGroups": len({row["agent_group"] for row in rows}),
        "featureNames": {}, "decisionRange": {"first": None, "last": None},
        "skipped": {"noFeatureVector": 0, "noDecision": 0},
        "sha256": hashlib.sha256(raw.encode("utf-8")).hexdigest(),
        "labelMeaning": review_module.LABEL_FOR,
        "fields": list(review_module.EXPECTED_FIELDS),
        "containsPersonalData": False,
    }
    manifest.update(manifest_overrides)
    (folder / review_module.MANIFEST_FILENAME).write_text(json.dumps(manifest), encoding="utf-8")
    return folder


@pytest.fixture()
def export(tmp_path: Path) -> review_module.ReviewLabels:
    rows = [label_row(1, 1), label_row(2, 0, group=2), label_row(3, 1, group=2)]
    return review_module.load_export(write_export(tmp_path / "review-labels-20261125T100000Z", rows))


@pytest.fixture(scope="session")
def retraining_config() -> Dict[str, Any]:
    return config_module.load_config(config_module.RETRAINING_CONFIG)


@pytest.fixture(scope="module")
def retrain_config(model_config) -> Dict[str, Any]:
    fast = copy.deepcopy(model_config)
    fast["xgboost"]["search_iterations"] = 2
    fast["xgboost"]["search_space"]["n_estimators"] = {"dist": "discrete", "values": [20], "weights": [1]}
    fast["cross_validation"]["n_repeats"] = 1
    fast["multi_seed"]["n_repeats"] = 1
    return fast


@pytest.fixture(scope="module")
def small(generated) -> Dict[str, Any]:
    _, _, internal, features = generated
    aligned = internal.labels.set_index("activation_id").reindex(features.keys["activation_id"])
    return {
        "keys": features.keys,
        "features": pd.concat([features.t0, features.t7], axis=1),
        "labels": aligned["is_fraudulent"].to_numpy().astype(int),
    }


# ----------------------------------------------------------------- the export


def test_label_mapping_is_refused_one_approved_zero(export: review_module.ReviewLabels) -> None:
    assert review_module.LABEL_FOR == {"approved": 0, "refused": 1}
    assert list(export.labels) == [1, 0, 1]
    assert list(export.frame["decision"]) == ["refused", "approved", "refused"]


def test_a_row_whose_label_contradicts_its_decision_is_refused(tmp_path: Path) -> None:
    rows = [label_row(1, 1, decision="approved")]
    with pytest.raises(review_module.ReviewLabelError, match="labels approved as 1"):
        review_module.load_export(write_export(tmp_path / "bad-label", rows))


def test_an_unexpected_field_is_refused_so_personal_data_cannot_arrive_quietly(tmp_path: Path) -> None:
    rows = [label_row(1, 1)]
    rows[0]["customer_msisdn"] = "0712345678"
    with pytest.raises(review_module.ReviewLabelError, match=r"unexpected field\(s\) \['customer_msisdn'\]"):
        review_module.load_export(write_export(tmp_path / "leaky", rows))


def test_the_export_fields_are_exactly_what_the_application_writes() -> None:
    source = (config_module.REPO_ROOT / "app" / "src" / "lib" / "labels" / "export.ts").read_text(encoding="utf-8")
    declared = source.split("export const ROW_FIELDS = [", 1)[1].split("] as const;", 1)[0]
    names = tuple(line.strip().strip('",') for line in declared.strip().splitlines())
    assert names == review_module.EXPECTED_FIELDS


def test_a_file_that_does_not_match_its_manifest_is_refused(tmp_path: Path) -> None:
    folder = write_export(tmp_path / "tampered", [label_row(1, 1)])
    (folder / review_module.LABELS_FILENAME).write_text(json.dumps(label_row(1, 0)) + "\n", encoding="utf-8")
    with pytest.raises(review_module.ReviewLabelError, match="does not match the sha256"):
        review_module.load_export(folder)


def test_a_manifest_whose_row_count_is_wrong_is_refused(tmp_path: Path) -> None:
    folder = write_export(tmp_path / "miscounted", [label_row(1, 1)], rows=5)
    with pytest.raises(review_module.ReviewLabelError, match="manifest says 5 rows"):
        review_module.load_export(folder)


def test_only_labels_scored_with_the_model_s_own_feature_set_are_used(tmp_path: Path) -> None:
    rows = [label_row(1, 1), label_row(2, 0, feature_set="t0", group=2)]
    export = review_module.load_export(write_export(tmp_path / "mixed", rows))
    assert len(export) == 2
    assert len(export.for_feature_set("t7", T7_FEATURES)) == 1
    assert len(export.for_feature_set("t0", data_module.FEATURE_SETS["t0"])) == 1


def test_the_newest_export_is_the_one_chosen(tmp_path: Path) -> None:
    write_export(tmp_path / "review-labels-20261101T000000Z", [label_row(1, 1)])
    write_export(tmp_path / "review-labels-20261125T000000Z", [label_row(1, 0)])
    assert review_module.latest_export(tmp_path).name == "review-labels-20261125T000000Z"


def test_a_missing_export_says_how_to_make_one(tmp_path: Path) -> None:
    with pytest.raises(review_module.ReviewLabelError, match="export-labels"):
        review_module.latest_export(tmp_path / "nothing-here")


# --------------------------------------------------------------- the pipeline


def test_review_rows_join_the_training_split_and_never_a_test_split(
    small, retrain_config, retraining_config, cfg, export
) -> None:
    plan = retrain_module.build_plan(retrain_config, retraining_config, [42], 1)
    folds = build_folds(small["keys"], small["labels"], cfg, retrain_config, with_calibration=True)
    records = retrain_module.compare_fold(
        small, folds[0], plan, retrain_config, 42,
        export.matrix(T7_FEATURES), export.labels,
    )
    by_arm = {record["arm"]: record for record in records}
    assert by_arm["baseline"]["n_fit_review"] == 0
    assert by_arm["candidate"]["n_fit_review"] == len(export)
    # The same test rows for both arms, and none of them a review row.
    assert by_arm["baseline"]["n_test"] == by_arm["candidate"]["n_test"] == float(len(folds[0].test_index))
    assert by_arm["candidate"]["review_weight_share"] == pytest.approx(
        len(export) / (len(export) + by_arm["candidate"]["n_fit_synthetic"])
    )


def test_the_comparison_is_the_same_every_time_for_one_seed_and_one_export(
    small, retrain_config, retraining_config, cfg, export
) -> None:
    plan = retrain_module.build_plan(retrain_config, retraining_config, [42], 1)
    folds = build_folds(small["keys"], small["labels"], cfg, retrain_config, with_calibration=True)
    arguments = (small, folds[0], plan, retrain_config, 42, export.matrix(T7_FEATURES), export.labels)
    first = retrain_module.compare_fold(*arguments)
    second = retrain_module.compare_fold(*arguments)
    assert pd.DataFrame(first).equals(pd.DataFrame(second))


def test_with_no_labels_the_candidate_is_the_baseline_exactly(small, retrain_config, retraining_config, cfg) -> None:
    plan = retrain_module.build_plan(retrain_config, retraining_config, [42], 1)
    folds = build_folds(small["keys"], small["labels"], cfg, retrain_config, with_calibration=True)
    empty = pd.DataFrame(columns=list(T7_FEATURES), dtype=float)
    records = retrain_module.compare_fold(
        small, folds[0], plan, retrain_config, 42, empty, np.array([], dtype=int)
    )
    baseline, candidate = records[0], records[1]
    assert baseline["pr_auc"] == candidate["pr_auc"]
    assert baseline["roc_auc"] == candidate["roc_auc"]


def test_weights_change_the_fit_so_the_weighting_is_really_applied(small, retrain_config) -> None:
    matrix = small["features"][list(T7_FEATURES)].iloc[:400]
    labels = small["labels"][:400]
    candidate = {"n_estimators": 20, "max_depth": 3, "learning_rate": 0.1, "min_child_weight": 1,
                 "subsample": 1.0, "colsample_bytree": 1.0, "reg_lambda": 1.0}
    plain = fit_xgboost(matrix, labels, candidate, "none", retrain_config, 1)
    weights = np.ones(len(labels))
    weights[labels == 1] = 50.0
    weighted = fit_xgboost(matrix, labels, candidate, "none", retrain_config, 1, sample_weight=weights)
    assert not np.allclose(plain.predict_proba(matrix)[:, 1], weighted.predict_proba(matrix)[:, 1])


def test_unweighted_fits_are_unchanged_by_the_new_argument(small, retrain_config) -> None:
    matrix = small["features"][list(T7_FEATURES)].iloc[:400]
    labels = small["labels"][:400]
    candidate = {"n_estimators": 20, "max_depth": 3, "learning_rate": 0.1, "min_child_weight": 1,
                 "subsample": 1.0, "colsample_bytree": 1.0, "reg_lambda": 1.0}
    without = fit_xgboost(matrix, labels, candidate, "none", retrain_config, 1)
    with_ones = fit_xgboost(matrix, labels, candidate, "none", retrain_config, 1, sample_weight=np.ones(len(labels)))
    assert np.array_equal(without.predict_proba(matrix)[:, 1], with_ones.predict_proba(matrix)[:, 1])


def test_weights_and_an_oversampler_cannot_be_combined(small, retrain_config) -> None:
    matrix = small["features"][list(T7_FEATURES)].iloc[:400]
    labels = small["labels"][:400]
    candidate = {"n_estimators": 20, "max_depth": 3, "learning_rate": 0.1, "min_child_weight": 1,
                 "subsample": 1.0, "colsample_bytree": 1.0, "reg_lambda": 1.0}
    with pytest.raises(ValueError, match="sample_weight cannot be combined with smote"):
        fit_xgboost(matrix, labels, candidate, "smote", retrain_config, 1, sample_weight=np.ones(len(labels)))


# ------------------------------------------------------- reporting, promotion


def _fold_frame() -> pd.DataFrame:
    rows = []
    for seed in (7, 42):
        for fold in (0, 1):
            for arm, pr in (("baseline", 0.70), ("candidate", 0.71)):
                rows.append({
                    "seed": seed, "fold": fold, "model": "t7_none", "arm": arm,
                    "n_fit_synthetic": 1000, "n_fit_review": 0 if arm == "baseline" else 3,
                    "review_weight_share": 0.0 if arm == "baseline" else 0.003,
                    "pr_auc": pr + 0.01 * fold + 0.02 * (seed == 42), "roc_auc": 0.9,
                    "recall_at_p90": 0.4, "recall_at_p95": 0.3,
                    "review_pr_auc": float("nan"), "review_mean_score": 0.5,
                })
    return pd.DataFrame(rows)


def test_the_summary_reports_the_spread_across_seeds(model_config) -> None:
    summary = retrain_module.summarise(_fold_frame(), model_config)
    pr_auc = summary[(summary["arm"] == "baseline") & (summary["metric"] == "pr_auc")].iloc[0]
    assert pr_auc["n_seeds"] == 2
    assert pr_auc["mean_across_seeds"] == pytest.approx(0.715)
    assert pr_auc["sd_across_seeds"] == pytest.approx(float(np.std([0.705, 0.725], ddof=1)))
    assert pr_auc["mean_fold_sd"] > 0


def test_the_report_refuses_to_call_a_handful_of_labels_informative(model_config, retraining_config, export) -> None:
    plan = retrain_module.build_plan(model_config, retraining_config, [7, 42], None)
    folds = _fold_frame()
    text = retrain_module.report(plan, export, folds, retrain_module.summarise(folds, model_config), model_config)
    assert "Not enough labels to support any promotion decision" in text
    assert f"min_labels_for_promotion` is {plan.min_labels}" in text
    assert "Nothing was promoted" in text
    assert "in sample" in text  # the review-label metrics are flagged for the candidate
    assert "not exchangeable" in text  # the fold-spread caveat CLAUDE.md requires


def test_the_retraining_parameters_are_configured_and_sourced(retraining_config) -> None:
    """Every parameter in config, with a source tag, as CLAUDE.md requires."""
    cfg = retraining_config["retraining"]
    assert set(cfg) == {"export_dir", "model", "review_label_weight", "seeds", "min_labels_for_promotion"}
    text = config_module.RETRAINING_CONFIG.read_text(encoding="utf-8")
    for name in cfg:
        line = next(line for line in text.splitlines() if line.strip().startswith(f"{name}:"))
        assert "source:" in line, f"{name} has no source tag"
        assert "controls:" in line, f"{name} does not say what it controls"


def test_the_retraining_config_leaves_the_committed_model_config_hash_alone() -> None:
    """The committed Phase 5 results record model.yaml's hash; retraining must not move it."""
    manifest = json.loads((config_module.REPO_ROOT / "outputs" / "multiseed_manifest.json").read_text(encoding="utf-8"))
    assert manifest["model_config_hash"] == config_module.config_hash([config_module.MODEL_CONFIG])
    assert "retraining" not in config_module.load_config(config_module.MODEL_CONFIG)


def test_the_pipeline_writes_no_artifact_and_names_no_deployment_step() -> None:
    source = (config_module.REPO_ROOT / "src" / "train" / "retrain.py").read_text(encoding="utf-8")
    # Past the module docstring, which names artifacts/ only to say it leaves them alone.
    body = source.split('"""', 2)[2]
    for forbidden in ("serve", "joblib", "save_model", "ARTIFACT", "artifacts"):
        assert forbidden not in body, f"the retraining pipeline must not reach {forbidden}"
    assert "PROMOTES NOTHING" in source


def test_running_the_pipeline_leaves_the_artifacts_untouched(tmp_path: Path, export, monkeypatch) -> None:
    artifacts = config_module.REPO_ROOT / "artifacts"
    before = sorted((path.name, path.stat().st_mtime_ns) for path in artifacts.rglob("*") if path.is_file())
    out = tmp_path / "out"
    monkeypatch.setattr(retrain_module, "run", lambda *_: _fold_frame())
    retrain_module.main(["--seeds", "7", "--folds", "1", "--export", str(export.path), "--out", str(out)])
    assert (out / "retraining_report.md").is_file()
    assert (out / "retraining_summary.csv").is_file()
    after = sorted((path.name, path.stat().st_mtime_ns) for path in artifacts.rglob("*") if path.is_file())
    assert after == before
