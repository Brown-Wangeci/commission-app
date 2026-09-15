"""Agents, devices, clients, customers and the simulated calendar.

Agent attributes are split into a public frame (what the platform records)
and a private frame (honesty type, ring membership, device pools). Only the
public frame ever reaches the observable log.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List

import numpy as np
import pandas as pd

from . import distributions as dist

HONESTY_TYPES = ("honest", "opportunistic", "systematic")
FLOAT_NOISE_DECIMALS = 9  # numerical tolerance, not a model parameter: stops 0.17 * 350 = 59.500000000000007 breaking a rounding tie


@dataclass(frozen=True)
class Population:
    public: pd.DataFrame
    private: pd.DataFrame
    calendar: pd.DataFrame
    payout_calendar: pd.DataFrame
    clients: np.ndarray
    customers: np.ndarray


def build_calendar(cfg: Dict[str, Any], rng: np.random.Generator) -> pd.DataFrame:
    """Day-level drivers: weekends, market days, campaign days, payout cycles."""
    sim = cfg["simulation"]
    cal_cfg = cfg["calendar"]
    num_days = int(sim["num_days"])
    dates = pd.date_range(sim["start_date"], periods=num_days, freq="D")
    frame = pd.DataFrame({"day_index": np.arange(num_days), "date": dates})
    frame["weekday"] = frame["date"].dt.weekday
    frame["is_weekend"] = frame["weekday"] == 6
    frame["is_market_day"] = frame["weekday"].isin(cal_cfg["market_weekdays"])

    cycle_length = int(cal_cfg["payout_cycle_length_days"])
    frame["cycle_id"] = frame["day_index"] // cycle_length
    frame["days_to_payout_cutoff"] = cycle_length - 1 - (frame["day_index"] % cycle_length)

    frame["is_campaign_day"] = False
    campaign_per_cycle = int(cal_cfg["campaign_days_per_cycle"])
    for cycle_id, group in frame.groupby("cycle_id"):
        chosen = rng.choice(group["day_index"].to_numpy(), size=campaign_per_cycle, replace=False)
        frame.loc[frame["day_index"].isin(chosen), "is_campaign_day"] = True

    frame["campaign_multiplier"] = np.where(
        frame["is_campaign_day"],
        dist.draw(cal_cfg["campaign_volume_multiplier"], rng, num_days),
        1.0,
    )
    frame["market_multiplier"] = np.where(
        frame["is_market_day"],
        dist.draw(cal_cfg["market_volume_multiplier"], rng, num_days),
        1.0,
    )
    frame["weekend_multiplier"] = np.where(
        frame["is_weekend"], float(cal_cfg["weekend_volume_multiplier"]), 1.0
    )
    return frame


def build_payout_calendar(cfg: Dict[str, Any], calendar: pd.DataFrame) -> pd.DataFrame:
    """Observable view of the payout schedule: one row per cycle."""
    cutoff_hour = float(cfg["calendar"]["payout_cutoff_hour"])
    rows = []
    for cycle_id, group in calendar.groupby("cycle_id"):
        cutoff_day = group["date"].max()
        rows.append(
            {
                "cycle_id": int(cycle_id),
                "cycle_start_date": group["date"].min(),
                "cutoff_timestamp": cutoff_day + pd.Timedelta(hours=cutoff_hour),
            }
        )
    return pd.DataFrame(rows)


def _scatter_locations(
    cfg: Dict[str, Any], rng: np.random.Generator, count: int
) -> pd.DataFrame:
    centers = cfg["population"]["urban_centers"]
    km_per_degree = float(cfg["geo"]["km_per_degree_latitude"])
    index = rng.integers(0, len(centers), count)
    base_lat = np.array([centers[i]["lat"] for i in index])
    base_lon = np.array([centers[i]["lon"] for i in index])
    region = np.array([centers[i]["region"] for i in index])

    radius = dist.draw(cfg["population"]["home_spread_km"], rng, count)
    bearing = rng.uniform(0.0, 2.0 * np.pi, count)
    lat = base_lat + (radius * np.cos(bearing)) / km_per_degree
    lon = base_lon + (radius * np.sin(bearing)) / (
        km_per_degree * np.cos(np.radians(base_lat))
    )
    return pd.DataFrame({"home_lat": lat, "home_lon": lon, "home_region": region})


def _assign_device_pools(
    cfg: Dict[str, Any], private: pd.DataFrame, rng: np.random.Generator
) -> pd.DataFrame:
    """Personal devices for everyone, plus shared devices for honest teams and rings."""
    counts = dist.draw(cfg["population"]["devices_per_agent"], rng, len(private)).astype(int)
    private["own_devices"] = [
        [f"dev_own_{agent}_{i}" for i in range(int(n))]
        for agent, n in zip(private["agent_id"], counts)
    ]
    private["shared_devices"] = [[] for _ in range(len(private))]

    lookalike = cfg["legitimate_lookalikes"]
    honest = private.index[private["honesty_type"] == "honest"].to_numpy()
    team_count = int(round(len(honest) * float(lookalike["device_sharing_team_share"])))
    team_pool = rng.permutation(honest)[:team_count]
    cursor = 0
    team_id = 0
    while cursor < len(team_pool):
        size = int(dist.draw(lookalike["team_size"], rng, 1)[0])
        members = team_pool[cursor : cursor + size]
        cursor += size
        if len(members) < 2:
            break
        device = f"dev_team_{team_id}"
        for member in members:
            private.at[member, "shared_devices"] = [device]
            private.at[member, "team_id"] = f"team_{team_id}"
        team_id += 1

    fraud_cfg = cfg["fraud_behaviour"]
    systematic = private.index[private["honesty_type"] == "systematic"].to_numpy()
    ring_count = int(round(len(systematic) * float(fraud_cfg["ring_membership_share"])))
    ring_pool = rng.permutation(systematic)[:ring_count]
    cursor = 0
    ring_id = 0
    while cursor < len(ring_pool):
        size = int(dist.draw(fraud_cfg["ring_size"], rng, 1)[0])
        members = ring_pool[cursor : cursor + size]
        cursor += size
        if len(members) < 2:
            break
        device_count = int(dist.draw(fraud_cfg["ring_device_count"], rng, 1)[0])
        devices = [f"dev_ring_{ring_id}_{i}" for i in range(device_count)]
        for member in members:
            private.at[member, "shared_devices"] = devices
            private.at[member, "ring_id"] = f"ring_{ring_id}"
        ring_id += 1
    return private


def stratified_type_counts(mix: Dict[str, float], total: int) -> Dict[str, int]:
    """Largest-remainder rounding of shares to whole agents; ties go to the smaller type."""
    shares = np.array([float(mix[t]) for t in HONESTY_TYPES])
    exact = shares / shares.sum() * total
    counts = np.floor(np.round(exact, FLOAT_NOISE_DECIMALS)).astype(int)
    remainder = np.round(exact - counts, FLOAT_NOISE_DECIMALS)
    order = sorted(range(len(HONESTY_TYPES)), key=lambda i: (-remainder[i], exact[i]))
    for i in order[: total - int(counts.sum())]:
        counts[i] += 1
    return {t: int(c) for t, c in zip(HONESTY_TYPES, counts)}


def assign_honesty_types(
    mix: Dict[str, float], total: int, rng: np.random.Generator
) -> np.ndarray:
    """Fixed number of agents per type for every seed; only the assignment is random."""
    counts = stratified_type_counts(mix, total)
    types = np.concatenate([np.full(counts[t], t, dtype=object) for t in HONESTY_TYPES])
    return rng.permutation(types).astype(str)


def build_agents(
    cfg: Dict[str, Any], rng: np.random.Generator
) -> tuple[pd.DataFrame, pd.DataFrame]:
    sim = cfg["simulation"]
    pop_cfg = cfg["population"]
    count = int(sim["num_agents"])
    agent_ids = np.array([f"agent_{i:04d}" for i in range(count)])

    honesty = assign_honesty_types(pop_cfg["agent_mix"], count, rng)

    tenure = dist.draw_by_profile(pop_cfg["tenure_days"], honesty, rng)
    start = pd.Timestamp(sim["start_date"])
    registration = start - pd.to_timedelta(tenure, unit="D")

    locations = _scatter_locations(cfg, rng, count)
    public = pd.DataFrame(
        {
            "agent_id": agent_ids,
            "agent_registration_date": registration.normalize(),
            "agent_home_lat": locations["home_lat"].to_numpy(),
            "agent_home_lon": locations["home_lon"].to_numpy(),
        }
    )

    sensitivity = np.zeros(count)
    for honesty_type in HONESTY_TYPES:
        mask = honesty == honesty_type
        if mask.any():
            sensitivity[mask] = dist.draw(
                pop_cfg["payout_sensitivity"][honesty_type], rng, int(mask.sum())
            )

    jobs_mean = np.array(
        [float(cfg["workload"]["jobs_per_day_mean"][t]) for t in honesty]
    ) * dist.draw(pop_cfg["jobs_mean_heterogeneity"], rng, count)

    private = pd.DataFrame(
        {
            "agent_id": agent_ids,
            "honesty_type": honesty,
            "payout_sensitivity": sensitivity,
            "jobs_mean": jobs_mean,
            "caution": dist.draw(pop_cfg["agent_caution"], rng, count),
            "home_region": locations["home_region"].to_numpy(),
            "ring_id": pd.Series([None] * count, dtype=object),
            "team_id": pd.Series([None] * count, dtype=object),
        }
    )

    fixed_share = float(cfg["legitimate_lookalikes"]["fixed_site_agent_share"])
    honest_mask = private["honesty_type"] == "honest"
    private["fixed_site"] = False
    honest_index = private.index[honest_mask].to_numpy()
    fixed_count = int(round(len(honest_index) * fixed_share))
    private.loc[rng.permutation(honest_index)[:fixed_count], "fixed_site"] = True

    private = _assign_device_pools(cfg, private, rng)
    return public, private


def _expected_activations(cfg: Dict[str, Any], private: pd.DataFrame, calendar: pd.DataFrame) -> int:
    day_multiplier = (
        calendar["campaign_multiplier"]
        * calendar["market_multiplier"]
        * calendar["weekend_multiplier"]
    ).sum()
    acceptance = float(cfg["workload"]["job_acceptance_rate"])
    return int(private["jobs_mean"].sum() * day_multiplier * acceptance)


def build_customer_pool(
    cfg: Dict[str, Any], private: pd.DataFrame, calendar: pd.DataFrame, rng: np.random.Generator
) -> np.ndarray:
    """MSISDN pool sized to the expected activation volume, then shuffled.

    Fresh customers are consumed from this pool without replacement, so honest
    repeat activations occur only through the explicit repeat mechanism.
    """
    expected = _expected_activations(cfg, private, calendar)
    size = int(np.ceil(expected * float(cfg["simulation"]["customer_pool_multiplier"])))
    pool = np.array([f"msisdn_{i:07d}" for i in range(size)])
    return rng.permutation(pool)


def build_population(cfg: Dict[str, Any], rng: np.random.Generator) -> Population:
    calendar = build_calendar(cfg, rng)
    payout_calendar = build_payout_calendar(cfg, calendar)
    public, private = build_agents(cfg, rng)
    customers = build_customer_pool(cfg, private, calendar, rng)
    clients = np.array([f"client_{i:03d}" for i in range(int(cfg["simulation"]["num_clients"]))])
    return Population(
        public=public,
        private=private,
        calendar=calendar,
        payout_calendar=payout_calendar,
        clients=clients,
        customers=customers,
    )
