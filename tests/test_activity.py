import pandas as pd
import pytest

from src.generator.schema import INTERNAL_COLUMNS, LeakageError, ObservableLog

from .conftest import build_everything


def test_observable_log_refuses_internal_columns(generated) -> None:
    _, observable, _, _ = generated
    leaking = observable.activations.assign(is_fraudulent=False)
    with pytest.raises(LeakageError):
        ObservableLog(
            activations=leaking,
            activity=observable.activity,
            agents=observable.agents,
            payout_calendar=observable.payout_calendar,
        )


def test_no_observable_frame_carries_internal_state(generated) -> None:
    _, observable, _, _ = generated
    for frame in (
        observable.activations,
        observable.activity,
        observable.agents,
        observable.payout_calendar,
    ):
        assert not INTERNAL_COLUMNS.intersection(frame.columns)


def test_activity_log_has_one_row_per_activation_day(generated, cfg) -> None:
    _, observable, _, _ = generated
    window = int(cfg["features"]["t7_window_days"])
    assert len(observable.activity) == len(observable.activations) * (window + 1)
    assert observable.activity["event_day"].max() == window
    assert observable.activity["event_day"].min() == 0


def test_internal_labels_align_one_to_one_with_activations(generated) -> None:
    _, observable, internal, _ = generated
    assert len(internal.labels) == len(observable.activations)
    assert set(internal.labels["activation_id"]) == set(observable.activations["activation_id"])
    assert internal.labels["activation_id"].is_unique


def test_job_timestamps_are_ordered(generated) -> None:
    _, observable, _, _ = generated
    activations = observable.activations
    assert (activations["job_assigned_timestamp"] <= activations["job_accepted_timestamp"]).all()
    assert (activations["job_accepted_timestamp"] <= activations["timestamp_submitted"]).all()


def test_submissions_fall_inside_the_simulation_window(generated, cfg) -> None:
    population, observable, _, _ = generated
    start = pd.Timestamp(cfg["simulation"]["start_date"])
    end = population.calendar["date"].max() + pd.Timedelta(days=1)
    submitted = observable.activations["timestamp_submitted"]
    assert submitted.min() >= start
    assert submitted.max() < end


def test_activations_are_sorted_by_submission_time(generated) -> None:
    _, observable, _, _ = generated
    assert observable.activations["timestamp_submitted"].is_monotonic_increasing


def test_sim_registration_never_postdates_submission(generated) -> None:
    _, observable, _, _ = generated
    activations = observable.activations
    assert (activations["sim_registration_date"] <= activations["timestamp_submitted"]).all()


def test_simulation_is_reproducible(cfg) -> None:
    _, first, first_internal, _ = build_everything(cfg)
    _, second, second_internal, _ = build_everything(cfg)
    pd.testing.assert_frame_equal(first.activations, second.activations)
    pd.testing.assert_frame_equal(first_internal.labels, second_internal.labels)
