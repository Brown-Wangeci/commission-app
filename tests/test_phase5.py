import numpy as np
import pandas as pd
import pytest

from src.eval.auto_release import measure, released_purity_threshold
from src.eval.bands import candidate_thresholds, cost_surface, optimum
from src.eval.calibration import expected_calibration_error, reliability_curve
from src.eval.costs import load_costs
from src.eval.cv import build_folds
from src.eval.fairness import assign_bands, queue_wait_days
from src.eval.lookalike_audit import stability
from src.train.multiseed import apply_calibrator, fit_calibrators

DAILY_ACTIVATIONS = 500.0


def test_review_cost_is_computed_from_its_parts() -> None:
    costs = load_costs(DAILY_ACTIVATIONS)
    raw = costs.raw
    expected = (
        float(raw["review_minutes"]) / 60.0
        * (float(raw["reviewer_monthly_cost_kes"]) / float(raw["working_hours_per_month"]))
        / float(raw["commission_value_kes"])
    )
    assert costs.review == pytest.approx(expected)
    low, high = raw["review_range"]
    assert low <= costs.review <= high


def test_capacity_share_follows_reviewers_and_volume() -> None:
    one = load_costs(DAILY_ACTIVATIONS, reviewers=1)
    two = load_costs(DAILY_ACTIVATIONS, reviewers=2)
    assert one.reviews_per_reviewer_day == pytest.approx(40.0)
    assert one.review_capacity_daily_share == pytest.approx(40.0 / DAILY_ACTIVATIONS)
    assert two.review_capacity_daily_share == pytest.approx(2 * one.review_capacity_daily_share)


def test_cost_overrides_only_touch_named_entries() -> None:
    costs = load_costs(DAILY_ACTIVATIONS, overrides={"false_negative": 4.0})
    assert costs.false_negative == 4.0
    assert costs.review == load_costs(DAILY_ACTIVATIONS).review


def test_calibration_split_is_held_out_of_the_model_fit(generated, cfg, model_config) -> None:
    _, _, internal, features = generated
    labels = (
        internal.labels.set_index("activation_id")
        .reindex(features.keys["activation_id"])["is_fraudulent"].to_numpy().astype(int)
    )
    folds = build_folds(features.keys, labels, cfg, model_config, with_calibration=True)
    agents = features.keys["agent_id"].to_numpy()
    for fold in folds:
        fit, calibration = set(fold.fit_index), set(fold.calibration_index)
        assert fit.isdisjoint(calibration)
        assert fit | calibration == set(fold.train_index)
        assert set(agents[fold.fit_index]).isdisjoint(set(agents[fold.calibration_index]))
        assert set(fold.inner_train_index) <= fit
        assert set(fold.inner_val_index) <= fit
        assert calibration.isdisjoint(set(fold.test_index))


def test_folds_without_calibration_match_phase_four(generated, cfg, model_config) -> None:
    _, _, internal, features = generated
    labels = (
        internal.labels.set_index("activation_id")
        .reindex(features.keys["activation_id"])["is_fraudulent"].to_numpy().astype(int)
    )
    folds = build_folds(features.keys, labels, cfg, model_config)
    for fold in folds:
        assert fold.fit_index is None
        assert np.array_equal(fold.model_fit_rows(), fold.train_index)


def test_calibrators_map_scores_monotonically() -> None:
    rng = np.random.default_rng(0)
    scores = rng.random(2000)
    labels = (rng.random(2000) < scores ** 2).astype(int)
    calibrators = fit_calibrators(scores, labels, ["isotonic", "sigmoid"])
    probe = np.linspace(0.01, 0.99, 50)
    for method, calibrator in calibrators.items():
        mapped = apply_calibrator(method, calibrator, probe)
        assert np.all(np.diff(mapped) >= -1e-9), f"{method} is not monotone"
        assert mapped.min() >= 0.0 and mapped.max() <= 1.0


def test_expected_calibration_error_catches_a_mislevelled_forecast() -> None:
    rng = np.random.default_rng(1)
    probabilities = rng.random(40000)
    labels = (rng.random(40000) < probabilities).astype(int)
    assert expected_calibration_error(labels, probabilities, 15) < 0.02
    assert expected_calibration_error(labels, np.clip(probabilities + 0.3, 0, 1), 15) > 0.1


def test_expected_calibration_error_does_not_penalise_lack_of_resolution() -> None:
    """A constant forecast at the base rate is calibrated but useless.

    Equal-count binning of a constant score puts the same mean prediction in
    every bin, so ECE stays near zero. ECE measures whether the stated
    probabilities are honest, not whether they separate anything, which is why
    the calibration choice is never made on ECE alone without PR-AUC beside it.
    """
    rng = np.random.default_rng(1)
    labels = (rng.random(40000) < 0.5).astype(int)
    assert expected_calibration_error(labels, np.full(40000, 0.5), 15) < 0.02
    assert expected_calibration_error(labels, np.full(40000, 0.9), 15) > 0.3


def test_reliability_curve_bins_have_equal_counts() -> None:
    rng = np.random.default_rng(2)
    probabilities = rng.random(1000)
    labels = (rng.random(1000) < probabilities).astype(int)
    curve = reliability_curve(labels, probabilities, 10)
    assert len(curve) == 10
    assert curve["rows"].max() - curve["rows"].min() <= 1


def test_released_purity_threshold_respects_the_target() -> None:
    labels = np.array([0, 0, 0, 0, 1, 0, 1, 1])
    probabilities = np.array([0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.9, 0.95])
    threshold = released_purity_threshold(labels, probabilities, 0.95)
    released = probabilities <= threshold
    assert 1.0 - labels[released].mean() >= 0.95
    assert released.sum() == 4


def test_auto_release_takes_the_largest_cutoff_meeting_the_purity_target() -> None:
    """The requirement is a property of the released set, so the largest
    satisfying cutoff is the answer even if purity dips and recovers below it."""
    labels = np.array([0, 1, 0, 0, 0, 0])
    probabilities = np.array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6])
    assert released_purity_threshold(labels, probabilities, 0.8) == pytest.approx(0.6)
    assert released_purity_threshold(labels, probabilities, 0.9) == pytest.approx(0.1)


def test_auto_release_measure_reports_value_slipping_through() -> None:
    labels = np.array([0, 1, 0, 1])
    probabilities = np.array([0.1, 0.2, 0.3, 0.9])
    commission = np.array([1.0, 2.0, 1.0, 1.0])
    result = measure(labels, probabilities, commission, 0.8)
    assert result["fraud_released_count"] == 0
    assert result["auto_released_share"] == pytest.approx(0.25)
    assert result["fraud_value_released_share"] == pytest.approx(0.0)
    generous = measure(labels, probabilities, commission, 0.5)
    assert generous["fraud_released_count"] == 2
    assert generous["fraud_value_released_commissions"] == pytest.approx(3.0)


def test_cost_surface_matches_a_hand_computed_case() -> None:
    labels = np.array([0, 0, 1, 1])
    probabilities = np.array([0.1, 0.4, 0.6, 0.9])
    grid = np.array([0.2, 0.8])
    costs = load_costs(DAILY_ACTIVATIONS, overrides={"false_negative": 2.0, "false_positive": 1.0})
    surface = cost_surface(labels, probabilities, grid, costs)
    point = surface[(surface["release_threshold"] == 0.2) & (surface["reject_threshold"] == 0.8)].iloc[0]
    # released: p<=0.2 is one genuine row. reviewed: 0.2<p<=0.8 is two rows.
    # rejected: p>0.8 is one fraudulent row, so no false positive cost.
    assert point["released_share"] == pytest.approx(0.25)
    assert point["review_share"] == pytest.approx(0.5)
    assert point["reject_share"] == pytest.approx(0.25)
    assert point["expected_cost"] == pytest.approx(2 * costs.review / 4)
    assert point["reject_precision"] == pytest.approx(1.0)
    assert point["reject_recall"] == pytest.approx(0.5)


def test_capacity_constraint_can_only_raise_the_optimum_cost() -> None:
    rng = np.random.default_rng(3)
    probabilities = rng.random(4000) ** 3
    labels = (rng.random(4000) < probabilities).astype(int)
    costs = load_costs(DAILY_ACTIVATIONS)
    grid = candidate_thresholds(probabilities, {"bands": {"sweep_quantiles": 40, "min_band_probability": 0.0005}})
    surface = cost_surface(labels, probabilities, grid, costs)
    free = optimum(surface, None)
    tight = optimum(surface, 0.05)
    assert tight["review_share"] <= 0.05 + 1e-12
    assert tight["expected_cost"] >= free["expected_cost"] - 1e-12


def test_band_assignment_uses_one_convention_at_the_boundary() -> None:
    probabilities = np.array([0.1, 0.2, 0.5, 0.8, 0.9])
    bands = assign_bands(probabilities, 0.2, 0.8)
    assert list(bands) == ["auto-released", "auto-released", "review", "review", "reject"]


def test_queue_wait_grows_with_utilisation_and_is_capped() -> None:
    light = queue_wait_days(0.02, 40.0, 500.0, 0.0, 30.0)
    heavy = queue_wait_days(0.079, 40.0, 500.0, 0.0, 30.0)
    over = queue_wait_days(0.5, 40.0, 500.0, 0.0, 30.0)
    assert light < heavy < over
    assert over == 30.0


def test_stability_only_calls_a_defect_when_every_seed_flags_it() -> None:
    table = pd.DataFrame({
        "typology": ["ghost"] * 4 + ["sim_farming"] * 4,
        "feature": ["a"] * 4 + ["b"] * 4,
        "flagged_no_counterpart": [True, True, True, True, True, False, False, False],
        "legitimate_share_in_region": [0.001, 0.002, 0.001, 0.003, 0.009, 0.02, 0.03, 0.02],
        "fraud_purity_of_region": [0.9] * 8,
        "legitimate_counterpart": ["none configured"] * 8,
        "seed": [7, 42, 101, 2024] * 2,
    })
    summary = stability(table, 4).set_index("feature")
    assert summary.loc["a", "verdict"].startswith("defect")
    assert summary.loc["b", "verdict"].startswith("noise")
