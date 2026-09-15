import numpy as np
import pandas as pd

from src.generator.population import (
    HONESTY_TYPES,
    assign_honesty_types,
    build_population,
    stratified_type_counts,
)
from src.generator.schema import INTERNAL_COLUMNS

from .conftest import SMALL_AGENTS, SMALL_DAYS


def test_agent_count_and_honesty_types(generated) -> None:
    population, _, _, _ = generated
    assert len(population.public) == SMALL_AGENTS
    assert len(population.private) == SMALL_AGENTS
    assert set(population.private["honesty_type"]).issubset(set(HONESTY_TYPES))


def test_public_agent_frame_hides_internal_attributes(generated) -> None:
    population, _, _, _ = generated
    assert not INTERNAL_COLUMNS.intersection(population.public.columns)
    assert "honesty_type" not in population.public.columns
    assert "fixed_site" not in population.public.columns


def test_calendar_covers_the_simulation_window(generated) -> None:
    population, _, _, _ = generated
    calendar = population.calendar
    assert len(calendar) == SMALL_DAYS
    assert calendar["days_to_payout_cutoff"].min() >= 0
    assert calendar["is_campaign_day"].sum() > 0


def test_payout_calendar_is_observable_and_ordered(generated) -> None:
    population, _, _, _ = generated
    payout = population.payout_calendar
    assert payout["cutoff_timestamp"].is_monotonic_increasing
    assert payout["cycle_id"].is_unique


def test_customer_pool_is_unique_and_large_enough(generated) -> None:
    population, observable, _, _ = generated
    assert len(set(population.customers)) == len(population.customers)
    assert len(population.customers) > len(observable.activations)


def test_every_agent_has_a_personal_device(generated) -> None:
    population, _, _, _ = generated
    assert all(len(devices) >= 1 for devices in population.private["own_devices"])


def test_teams_and_rings_share_their_devices(generated) -> None:
    population, _, _, _ = generated
    private = population.private
    for group_column in ("team_id", "ring_id"):
        grouped = private[private[group_column].notna()].groupby(group_column)
        for _, members in grouped:
            assert len(members) >= 2
            shared = [tuple(row) for row in members["shared_devices"]]
            assert len(set(shared)) == 1


def test_honesty_mix_is_stratified_not_sampled(cfg) -> None:
    """Every seed yields exactly the same number of agents of each type."""
    expected = stratified_type_counts(cfg["population"]["agent_mix"], SMALL_AGENTS)
    for seed in (7, 42, 101, 2024):
        population = build_population(cfg, np.random.default_rng(seed))
        realised = population.private["honesty_type"].value_counts().to_dict()
        assert {t: realised.get(t, 0) for t in HONESTY_TYPES} == expected


def test_stratified_counts_sum_and_break_ties_toward_the_smaller_type() -> None:
    counts = stratified_type_counts({"honest": 0.78, "opportunistic": 0.17, "systematic": 0.05}, 350)
    assert sum(counts.values()) == 350
    assert counts == {"honest": 273, "opportunistic": 59, "systematic": 18}


def test_honesty_assignment_is_shuffled_across_agent_ids(cfg) -> None:
    first = assign_honesty_types(cfg["population"]["agent_mix"], SMALL_AGENTS, np.random.default_rng(1))
    second = assign_honesty_types(cfg["population"]["agent_mix"], SMALL_AGENTS, np.random.default_rng(2))
    assert sorted(first) == sorted(second)
    assert list(first) != list(second)


def test_generation_is_reproducible(cfg) -> None:
    first = build_population(cfg, np.random.default_rng(int(cfg["seed"])))
    second = build_population(cfg, np.random.default_rng(int(cfg["seed"])))
    pd.testing.assert_frame_equal(first.public, second.public)
