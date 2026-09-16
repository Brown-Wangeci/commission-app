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


def test_held_jobs_have_honest_company_in_the_long_latency_tail(generated, cfg) -> None:
    """Defect 1 regression: the acceptance-latency tail must not be fraud-only."""
    _, _, internal, features = generated
    labels = internal.labels.set_index("activation_id").reindex(features.keys["activation_id"])
    latency = features.t0["job_acceptance_latency_seconds"].to_numpy()
    gaming = (labels["fraud_typology"] == "payout_gaming").to_numpy()
    legitimate = ~labels["is_fraudulent"].to_numpy()
    threshold = float(pd.Series(latency[gaming]).quantile(0.75))
    legitimate_share = float((latency[legitimate] > threshold).mean())
    assert legitimate_share > 0.01, "no honest counterpart to the held payout-gaming job"


def test_careful_payout_gaming_can_disguise_its_timing(generated, cfg) -> None:
    """Defect 2 regression: the before-cutoff hour must not be forced on careful rows."""
    _, observable, internal, _ = generated
    labels = internal.labels.set_index("activation_id")
    submitted = observable.activations.set_index("activation_id")["timestamp_submitted"]
    careful_gaming = labels[(labels["fraud_typology"] == "payout_gaming") & labels["careful"]].index
    hours = submitted.loc[careful_gaming].dt.hour + submitted.loc[careful_gaming].dt.minute / 60.0
    cutoff_hour = float(cfg["calendar"]["payout_cutoff_hour"])
    assert (hours > cutoff_hour).any(), "every careful gaming row still sits before the cutoff hour"


def test_simulation_is_reproducible(cfg) -> None:
    _, first, first_internal, _ = build_everything(cfg)
    _, second, second_internal, _ = build_everything(cfg)
    pd.testing.assert_frame_equal(first.activations, second.activations)
    pd.testing.assert_frame_equal(first_internal.labels, second_internal.labels)
