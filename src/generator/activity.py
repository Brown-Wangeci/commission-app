"""Turns activation plans into the observable event log.

This module is the only place where internal plan state and observable fields
sit side by side. It returns them as two separate objects, and nothing
downstream is handed both.
"""

from __future__ import annotations

from typing import Any, Dict, Tuple

import numpy as np
import pandas as pd

from . import distributions as dist
from . import typologies as typ
from .population import Population
from .schema import InternalState, ObservableLog

HOURS_PER_DAY = 24.0


def _profile_from_mode(modes: np.ndarray, known: Tuple[str, ...], fallback: str) -> np.ndarray:
    return np.where(np.isin(modes, known), modes, fallback)


def _submission_hours(
    cfg: Dict[str, Any], plan: pd.DataFrame, careful_blend: np.ndarray, rng: np.random.Generator
) -> np.ndarray:
    """Hour of day, clustered within each agent-day by a width that varies by context."""
    modes = plan["mode"].to_numpy()
    count = len(plan)

    hour_profile = _profile_from_mode(modes, ("fraud_ghost", "fraud_sim_farming"), "standard")
    hour_profile = typ.apply_mimicry(
        hour_profile, typ.mimic_mask(plan["careful"].to_numpy(), careful_blend, rng), "standard"
    )
    base_hour = dist.draw_by_profile(typ.hour_specs(cfg), hour_profile, rng)

    spread_profile = np.where(
        modes == "fraud_sim_farming",
        "farm_burst",
        np.where(plan["flag_burst_day"].to_numpy(), "honest_burst", "standard"),
    )
    spread_profile = typ.apply_mimicry(
        spread_profile, typ.mimic_mask(plan["careful"].to_numpy(), careful_blend, rng), "standard"
    )
    spread = dist.draw_by_profile(typ.spread_specs(cfg), spread_profile, rng)

    codes, first_index = _group_codes(plan)
    anchor = base_hour[first_index[codes]]
    hours = anchor + rng.normal(0.0, spread)

    gaming = modes == "fraud_payout_gaming"
    if gaming.any():
        cutoff_hour = float(cfg["calendar"]["payout_cutoff_hour"])
        offset = dist.draw(
            cfg["typologies"]["payout_gaming"]["cutoff_window_hours"], rng, int(gaming.sum())
        )
        hours[gaming] = cutoff_hour - offset
    return np.clip(hours, 0.0, HOURS_PER_DAY - 0.02)


def _group_codes(plan: pd.DataFrame) -> Tuple[np.ndarray, np.ndarray]:
    key = plan["agent_id"].astype(str) + "|" + plan["day_index"].astype(str)
    codes, _ = pd.factorize(key)
    _, first_index = np.unique(codes, return_index=True)
    return codes, first_index


def _assign_devices(
    plan: pd.DataFrame, private: pd.DataFrame, use_shared: np.ndarray, rng: np.random.Generator
) -> np.ndarray:
    own_map = dict(zip(private["agent_id"], private["own_devices"]))
    shared_map = dict(zip(private["agent_id"], private["shared_devices"]))
    devices = np.empty(len(plan), dtype=object)
    for agent_id, positions in plan.groupby("agent_id").indices.items():
        own = np.asarray(own_map[agent_id])
        devices[positions] = own[rng.integers(0, len(own), len(positions))]
        shared = np.asarray(shared_map[agent_id], dtype=object)
        if len(shared) == 0:
            continue
        shared_rows = positions[use_shared[positions]]
        if len(shared_rows):
            devices[shared_rows] = shared[rng.integers(0, len(shared), len(shared_rows))]
    return devices


def _assign_customers(
    plan: pd.DataFrame, pool: np.ndarray, rng: np.random.Generator
) -> np.ndarray:
    """Fresh MSISDNs are consumed without replacement; repeats reuse a seen number."""
    repeat = plan["flag_repeat_msisdn"].to_numpy()
    picks = rng.random(len(plan))
    assigned = np.empty(len(plan), dtype=object)
    seen: list[str] = []
    cursor = 0
    for i in range(len(plan)):
        if repeat[i] and seen:
            assigned[i] = seen[int(picks[i] * len(seen))]
        else:
            assigned[i] = pool[cursor]
            cursor += 1
            seen.append(assigned[i])
    return assigned


def _locations(
    cfg: Dict[str, Any], plan: pd.DataFrame, distance_km: np.ndarray, rng: np.random.Generator
) -> Tuple[np.ndarray, np.ndarray]:
    km_per_degree = float(cfg["geo"]["km_per_degree_latitude"])
    home_lat = plan["agent_home_lat"].to_numpy()
    home_lon = plan["agent_home_lon"].to_numpy()
    bearing = rng.uniform(0.0, 2.0 * np.pi, len(plan))
    lat = home_lat + (distance_km * np.cos(bearing)) / km_per_degree
    lon = home_lon + (distance_km * np.sin(bearing)) / (
        km_per_degree * np.cos(np.radians(home_lat))
    )
    return lat, lon


def _rate_by_mode(
    cfg: Dict[str, Any], modes: np.ndarray, key: str, legit_rate: float
) -> np.ndarray:
    """Per-row probability for a binary field, overridden per typology where configured."""
    rates = np.full(len(modes), float(legit_rate))
    for name in typ.FRAUD_TYPOLOGIES:
        override = cfg["typologies"][name].get(key)
        if override is not None:
            rates[modes == f"fraud_{name}"] = float(override)
    return rates


def _revert_when_mimicking(
    rates: np.ndarray,
    legit_rate: float,
    careful: np.ndarray,
    blend: np.ndarray,
    rng: np.random.Generator,
) -> np.ndarray:
    """A careful fraud row falls back to the ordinary legitimate rate."""
    out = np.asarray(rates, dtype=float).copy()
    out[typ.mimic_mask(careful, blend, rng)] = float(legit_rate)
    return out


def _ip_regions(
    cfg: Dict[str, Any], plan: pd.DataFrame, mismatch: np.ndarray, rng: np.random.Generator
) -> np.ndarray:
    """A mismatched submission reports some region other than the agent's own."""
    regions = np.array([center["region"] for center in cfg["population"]["urban_centers"]])
    lookup = {region: index for index, region in enumerate(regions)}
    home = plan["home_region"].to_numpy()
    home_index = np.array([lookup[region] for region in home])
    offset = rng.integers(1, len(regions), len(plan))
    return np.where(mismatch, regions[(home_index + offset) % len(regions)], home)


CHANNELS = ("transactions", "topup", "usage_minutes")


def _channel_propensities(
    cfg: Dict[str, Any], count: int, rng: np.random.Generator
) -> Dict[str, np.ndarray]:
    """Per-customer lognormal propensity per channel, mean 1, sharing one common component."""
    channels = cfg["downstream_channels"]
    rho = float(channels["propensity_log_correlation"])
    shared = rng.normal(size=count)
    propensities = {}
    for name in CHANNELS:
        sigma = float(channels[name]["propensity_log_sigma"])
        latent = np.sqrt(rho) * shared + np.sqrt(1.0 - rho) * rng.normal(size=count)
        propensities[name] = np.exp(sigma * latent - sigma**2 / 2.0)
    return propensities


def _channel_scale(
    channel_cfg: Dict[str, Any], engagement: np.ndarray, propensity: np.ndarray
) -> np.ndarray:
    """Per-customer multiplier: partial dependence on engagement times own propensity."""
    return (engagement ** float(channel_cfg["engagement_elasticity"]) * propensity)[:, None]


def _usage_channels(
    cfg: Dict[str, Any], engagement: np.ndarray, active: np.ndarray, rng: np.random.Generator
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Transactions, topup and minutes, each with its own propensity and daily noise."""
    channels = cfg["downstream_channels"]
    count, width = active.shape
    propensity = _channel_propensities(cfg, count, rng)

    tx_cfg = channels["transactions"]
    dispersion = float(tx_cfg["daily_dispersion"])
    day_rate = rng.gamma(dispersion, 1.0 / dispersion, active.shape)
    tx_rate = float(tx_cfg["per_active_day"]) * _channel_scale(tx_cfg, engagement, propensity["transactions"])
    transactions = rng.poisson(tx_rate * day_rate * active)

    topup_cfg = channels["topup"]
    topup_day = rng.random(active.shape) < dist.draw(topup_cfg["topup_day_prob"], rng, count)[:, None]
    topup = dist.draw(topup_cfg["per_active_day"], rng, count * width).reshape(active.shape)
    topup = topup * _channel_scale(topup_cfg, engagement, propensity["topup"]) * active * topup_day

    minutes_cfg = channels["usage_minutes"]
    minutes = dist.draw(minutes_cfg["per_active_day"], rng, count * width).reshape(active.shape)
    minutes = minutes * _channel_scale(minutes_cfg, engagement, propensity["usage_minutes"]) * active
    return transactions, topup, minutes


def _downstream_activity(
    cfg: Dict[str, Any],
    activation_ids: np.ndarray,
    engagement: np.ndarray,
    decay: np.ndarray,
    complaint_prob: np.ndarray,
    hazard: np.ndarray,
    support_prob: np.ndarray,
    rng: np.random.Generator,
) -> pd.DataFrame:
    legit = cfg["legit_behaviour"]
    window = int(cfg["features"]["t7_window_days"])
    days = np.arange(window + 1)
    count = len(activation_ids)
    shape = (count, window + 1)

    daily_prob = engagement[:, None] * decay[:, None] ** days[None, :]
    active = rng.random(shape) < daily_prob
    transactions, topup, minutes = _usage_channels(cfg, engagement, active, rng)

    support = (rng.random(shape) < support_prob[:, None]) & active
    complaint = rng.random(shape) < complaint_prob[:, None]

    shield = float(legit["sim_hazard_engagement_shield"])
    daily_hazard = hazard[:, None] * (1.0 - shield * engagement[:, None])
    deactivated = np.cumsum(rng.random(shape) < daily_hazard, axis=1) > 0

    return pd.DataFrame(
        {
            "activation_id": np.repeat(activation_ids, window + 1),
            "event_day": np.tile(days, count),
            "customer_active_flag": active.ravel(),
            "transaction_count": transactions.ravel(),
            "topup_amount": topup.ravel(),
            "usage_minutes": minutes.ravel(),
            "support_contact_flag": support.ravel(),
            "complaint_or_refund_flag": complaint.ravel(),
            "sim_active_flag": ~deactivated.ravel(),
        }
    )


def _preferred_clients(
    cfg: Dict[str, Any], plan: pd.DataFrame, clients: np.ndarray, rng: np.random.Generator
) -> np.ndarray:
    choice = dist.draw(cfg["workload"]["activation_client_choice"], rng, len(plan)).astype(int)
    assigned = np.empty(len(plan), dtype=object)
    for positions in plan.groupby("agent_id").indices.values():
        preferred = rng.permutation(clients)[: choice.max() + 1]
        assigned[positions] = preferred[choice[positions]]
    return assigned


def simulate(
    cfg: Dict[str, Any], population: Population, rng: np.random.Generator
) -> Tuple[ObservableLog, InternalState]:
    plan = typ.plan_activations(cfg, population, rng)
    plan = plan.merge(population.public, on="agent_id", how="left")
    plan = plan.merge(
        population.private[["agent_id", "home_region"]], on="agent_id", how="left"
    )

    careful = plan["careful"].to_numpy()
    blend = np.zeros(len(plan))
    if careful.any():
        blend[careful] = dist.draw(
            cfg["fraud_behaviour"]["careful_blend"], rng, int(careful.sum())
        )
    plan["careful_blend"] = blend

    hours = _submission_hours(cfg, plan, blend, rng)
    dates = population.calendar["date"].to_numpy()[plan["day_index"].to_numpy()]
    plan["timestamp_submitted"] = pd.to_datetime(dates) + pd.to_timedelta(hours, unit="h")
    plan = plan.sort_values("timestamp_submitted", kind="stable").reset_index(drop=True)
    plan["activation_id"] = [f"act_{i:07d}" for i in range(len(plan))]

    modes = plan["mode"].to_numpy()
    careful = plan["careful"].to_numpy()
    careful_blend = plan["careful_blend"].to_numpy()
    count = len(plan)

    engagement_profile = typ.apply_mimicry(
        modes, typ.mimic_mask(careful, careful_blend, rng), "legit_normal"
    )
    engagement = dist.draw_by_profile(typ.engagement_specs(cfg), engagement_profile, rng)
    decay = dist.draw_by_profile(typ.decay_specs(cfg), engagement_profile, rng)

    distance_profile = np.where(
        np.char.startswith(modes.astype(str), "fraud_"),
        modes,
        np.where(plan["flag_fixed_site"].to_numpy(), "legit_fixed_site", "legit_mobile"),
    )
    distance_profile = typ.apply_mimicry(
        distance_profile, typ.mimic_mask(careful, careful_blend, rng), "legit_mobile"
    )
    distance_km = dist.draw_by_profile(typ.distance_specs(cfg), distance_profile, rng)

    sim_age_profile = np.where(
        modes == "fraud_sim_farming",
        "farm",
        np.where(plan["flag_same_day_sim"].to_numpy(), "same_day", "standard"),
    )
    sim_age_profile = typ.apply_mimicry(
        sim_age_profile, typ.mimic_mask(careful, careful_blend, rng), "standard"
    )
    sim_age_days = dist.draw_by_profile(typ.sim_age_specs(cfg), sim_age_profile, rng)

    complaint_profile = typ.apply_mimicry(
        _profile_from_mode(modes, ("fraud_ghost", "fraud_collusion"), "standard"),
        typ.mimic_mask(careful, careful_blend, rng),
        "standard",
    )
    complaint_prob = dist.draw_by_profile(typ.complaint_specs(cfg), complaint_profile, rng)

    hazard_profile = typ.apply_mimicry(
        _profile_from_mode(modes, ("fraud_ghost",), "standard"),
        typ.mimic_mask(careful, careful_blend, rng),
        "standard",
    )
    hazard = dist.draw_by_profile(typ.hazard_specs(cfg), hazard_profile, rng)
    support_prob = dist.draw(cfg["legit_behaviour"]["support_contact_daily_prob"], rng, count)

    held = (modes == "fraud_payout_gaming") & (
        rng.random(count) < dist.draw(
            cfg["typologies"]["payout_gaming"]["held_release_share"], rng, count
        )
    )
    acceptance_profile = typ.apply_mimicry(
        np.where(held, "held", "standard"), typ.mimic_mask(careful, careful_blend, rng), "standard"
    )
    acceptance_latency = dist.draw_by_profile(
        typ.acceptance_latency_specs(cfg), acceptance_profile, rng
    )
    submission_profile = np.where(
        np.isin(modes, ("fraud_ghost", "fraud_sim_farming")),
        modes,
        np.where(plan["flag_burst_day"].to_numpy(), "fast_honest", "standard"),
    )
    submission_profile = typ.apply_mimicry(
        submission_profile, typ.mimic_mask(careful, careful_blend, rng), "standard"
    )
    submission_latency = dist.draw_by_profile(
        typ.submission_latency_specs(cfg), submission_profile, rng
    )

    legit = cfg["legit_behaviour"]
    rates = {
        key: _revert_when_mimicking(
            _rate_by_mode(cfg, modes, key, legit[key]), legit[key], careful, careful_blend, rng
        )
        for key in ("manual_entry_rate", "proof_missing_rate", "ip_mismatch_rate", "cellular_rate")
    }
    manual_entry = rng.random(count) < rates["manual_entry_rate"]
    proof_missing = rng.random(count) < rates["proof_missing_rate"]
    ip_mismatch = rng.random(count) < rates["ip_mismatch_rate"]
    cellular = rng.random(count) < rates["cellular_rate"]

    use_shared = plan["flag_shared_device"].to_numpy() & ~typ.mimic_mask(
        careful, careful_blend, rng
    )
    devices = _assign_devices(plan, population.private, use_shared, rng)
    latitudes, longitudes = _locations(cfg, plan, distance_km, rng)
    customers = _assign_customers(plan, population.customers, rng)

    submitted = plan["timestamp_submitted"]
    accepted = submitted - pd.to_timedelta(submission_latency, unit="m")
    assigned = accepted - pd.to_timedelta(acceptance_latency, unit="m")

    activations = pd.DataFrame(
        {
            "activation_id": plan["activation_id"],
            "agent_id": plan["agent_id"],
            "job_id": [f"job_{i:07d}" for i in range(count)],
            "client_business_id": _preferred_clients(cfg, plan, population.clients, rng),
            "job_assigned_timestamp": assigned,
            "job_accepted_timestamp": accepted,
            "timestamp_submitted": submitted,
            "device_id": devices,
            "device_os": dist.draw(cfg["workload"]["device_os_mix"], rng, count),
            "app_version": dist.draw(cfg["workload"]["app_version_mix"], rng, count),
            "ip_geolocation_region": _ip_regions(cfg, plan, ip_mismatch, rng),
            "network_type": np.where(cellular, "cellular", "wifi"),
            "submission_gps_lat": latitudes,
            "submission_gps_lon": longitudes,
            "customer_msisdn_hash": customers,
            "sim_registration_date": (submitted - pd.to_timedelta(sim_age_days, unit="D")).dt.normalize(),
            "activation_method": np.where(manual_entry, "manual_entry", "qr_scan"),
            "proof_of_activation_hash": pd.Series(
                [None if missing else f"proof_{i:07d}" for i, missing in enumerate(proof_missing)],
                dtype=object,
            ),
            "escrow_amount": dist.draw(cfg["workload"]["escrow_amount"], rng, count),
            "commission_rate": float(cfg["workload"]["commission_rate"]),
        }
    )

    activity = _downstream_activity(
        cfg,
        plan["activation_id"].to_numpy(),
        engagement,
        decay,
        complaint_prob,
        hazard,
        support_prob,
        rng,
    )

    observable = ObservableLog(
        activations=activations,
        activity=activity,
        agents=population.public,
        payout_calendar=population.payout_calendar,
    )
    internal = InternalState(
        labels=plan[
            [
                "activation_id",
                "agent_id",
                "is_fraudulent",
                "fraud_typology",
                "mode",
                "careful",
                "honesty_type",
                "episode_id",
                "is_ambiguous",
                *typ.FLAG_COLUMNS,
            ]
        ].assign(engagement=engagement)
    )
    return observable, internal
