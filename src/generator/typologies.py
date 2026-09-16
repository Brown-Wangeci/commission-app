"""Fraud typologies, legitimate lookalikes, and the plan for every activation.

Fraud is never an independent per-row coin flip. An agent enters a fraud
episode on a given day as a consequence of the agent's honesty type and the
day's situation (chiefly proximity to a payout cutoff). Only some of the
activations inside an episode are fraudulent, so episodes mix real and fake
work the way a real agent's day would.

Every fraud signature produced here has a legitimate counterpart drawn from
an overlapping distribution, so no observable pattern belongs exclusively to
one class.
"""

from __future__ import annotations

from typing import Any, Dict, List

import numpy as np
import pandas as pd

from . import distributions as dist
from .population import Population

LEGIT_MODES = ("legit_normal", "legit_dormant", "legit_trial_lapse")
FRAUD_TYPOLOGIES = ("ghost", "sim_farming", "collusion", "payout_gaming")
FRAUD_MODES = tuple(f"fraud_{name}" for name in FRAUD_TYPOLOGIES)

FLAG_COLUMNS = (
    "flag_dormant",
    "flag_burst_day",
    "flag_shared_device",
    "flag_same_day_sim",
    "flag_fixed_site",
    "flag_end_cycle_push",
    "flag_repeat_msisdn",
    "flag_batch_acceptance",
    "flag_event_backlog",
)


def _episode_probability(
    cfg: Dict[str, Any],
    honesty_type: str,
    days_to_cutoff: np.ndarray,
    rng: np.random.Generator,
) -> np.ndarray:
    fraud_cfg = cfg["fraud_behaviour"]
    base = float(fraud_cfg["episode_daily_prob"][honesty_type])
    if base <= 0.0:
        return np.zeros(len(days_to_cutoff))
    multiplier = dist.draw_one(fraud_cfg["payout_proximity_multiplier"][honesty_type], rng)
    near_cutoff = days_to_cutoff <= int(fraud_cfg["payout_proximity_window_days"])
    return np.clip(np.where(near_cutoff, base * multiplier, base), 0.0, 1.0)


def _daily_volume_multiplier(
    cfg: Dict[str, Any],
    calendar: pd.DataFrame,
    payout_sensitivity: float,
    rng: np.random.Generator,
) -> np.ndarray:
    """Campaign, market and weekend effects, plus the honest end-of-cycle push."""
    lookalike = cfg["legitimate_lookalikes"]
    num_days = len(calendar)
    multiplier = (
        calendar["campaign_multiplier"].to_numpy()
        * calendar["market_multiplier"].to_numpy()
        * calendar["weekend_multiplier"].to_numpy()
    )
    push = dist.draw(lookalike["end_cycle_push_multiplier"], rng, num_days)
    in_window = (
        calendar["days_to_payout_cutoff"].to_numpy()
        <= int(lookalike["end_cycle_push_window_days"])
    )
    pushed = multiplier * (1.0 + (push - 1.0) * payout_sensitivity)
    return np.where(in_window, pushed, multiplier)


def _careful_probability(
    cfg: Dict[str, Any], typology: np.ndarray, is_fraud: np.ndarray, caution: float
) -> np.ndarray:
    """careful_share scaled by this agent's caution relative to the population mean.

    Averaged over agents this equals careful_share, so the configured value is
    the population-average share of disguised activations for the typology.
    """
    shares = cfg["fraud_behaviour"]["careful_share"]
    mean_caution = dist.expected_value(cfg["population"]["agent_caution"])
    base = np.array([float(shares[t]) if f else 0.0 for t, f in zip(typology, is_fraud)])
    return np.clip(base * float(caution) / mean_caution, 0.0, 1.0)


def _plan_one_agent(
    cfg: Dict[str, Any],
    agent: pd.Series,
    calendar: pd.DataFrame,
    rng: np.random.Generator,
) -> pd.DataFrame:
    fraud_cfg = cfg["fraud_behaviour"]
    lookalike = cfg["legitimate_lookalikes"]
    num_days = len(calendar)
    days_to_cutoff = calendar["days_to_payout_cutoff"].to_numpy()

    multiplier = _daily_volume_multiplier(cfg, calendar, agent["payout_sensitivity"], rng)
    episode = rng.random(num_days) < _episode_probability(
        cfg, agent["honesty_type"], days_to_cutoff, rng
    )
    episode_multiplier = dist.draw(fraud_cfg["episode_volume_multiplier"], rng, num_days)
    daily_mean = np.where(
        episode, agent["jobs_mean"] * multiplier * episode_multiplier, agent["jobs_mean"] * multiplier
    )

    jobs = rng.poisson(daily_mean)
    accepted = rng.binomial(jobs, float(cfg["workload"]["job_acceptance_rate"]))
    if accepted.sum() == 0:
        return pd.DataFrame()

    day_index = np.repeat(np.arange(num_days), accepted)
    count = len(day_index)

    if agent["honesty_type"] in fraud_cfg["typology_weights"]:
        weights = fraud_cfg["typology_weights"][agent["honesty_type"]]
        day_typology = dist.weighted_choice(
            list(weights.keys()), list(weights.values()), rng, num_days
        )
    else:
        day_typology = np.array([FRAUD_TYPOLOGIES[0]] * num_days)

    fraud_share = dist.draw(fraud_cfg["fraud_share_within_episode"], rng, num_days)
    is_fraud = episode[day_index] & (rng.random(count) < fraud_share[day_index])

    mix = cfg["legit_behaviour"]["mode_mix"]
    legit_mode = dist.weighted_choice(list(mix.keys()), list(mix.values()), rng, count)
    mode = np.where(is_fraud, np.char.add("fraud_", day_typology[day_index]),
                    np.char.add("legit_", legit_mode))
    typology = np.where(is_fraud, day_typology[day_index], "none")

    careful = rng.random(count) < _careful_probability(cfg, typology, is_fraud, agent["caution"])

    on_team = agent["team_id"] is not None
    in_ring = agent["ring_id"] is not None
    shared_device = np.zeros(count, dtype=bool)
    if on_team:
        shared_device |= rng.random(count) < float(lookalike["team_device_use_prob"])
    if in_ring:
        farm_rows = mode == "fraud_sim_farming"
        shared_device |= farm_rows & (
            rng.random(count) < float(cfg["typologies"]["sim_farming"]["ring_device_use_prob"])
        )

    repeat_rate = np.where(
        mode == "fraud_sim_farming",
        float(cfg["typologies"]["sim_farming"]["repeat_msisdn_rate"]),
        float(cfg["legit_behaviour"]["repeat_msisdn_rate"]),
    )
    same_day_rate = np.where(
        mode == "fraud_collusion",
        float(cfg["typologies"]["collusion"]["same_day_sim_share"]),
        float(lookalike["same_day_sim_share"]),
    )

    burst_day = (
        calendar["is_campaign_day"].to_numpy() | calendar["is_market_day"].to_numpy()
    )[day_index]
    end_cycle = (days_to_cutoff <= int(lookalike["end_cycle_push_window_days"]))[day_index]

    return pd.DataFrame(
        {
            "agent_id": agent["agent_id"],
            "day_index": day_index,
            "honesty_type": agent["honesty_type"],
            "episode_id": np.where(
                episode[day_index], [f"{agent['agent_id']}_d{d}" for d in day_index], "none"
            ),
            "is_fraudulent": is_fraud,
            "fraud_typology": typology,
            "mode": mode,
            "careful": careful & is_fraud,
            "flag_dormant": mode == "legit_dormant",
            "flag_burst_day": burst_day,
            "flag_shared_device": shared_device,
            "flag_same_day_sim": rng.random(count) < same_day_rate,
            "flag_fixed_site": bool(agent["fixed_site"]),
            "flag_end_cycle_push": end_cycle,
            "flag_repeat_msisdn": rng.random(count) < repeat_rate,
            "flag_batch_acceptance": bool(agent["batch_acceptor"])
            & (rng.random(count) < float(lookalike["batch_acceptance_activation_prob"])),
            "flag_event_backlog": rng.random(count) < float(lookalike["event_backlog_share"]),
        }
    )


def plan_activations(
    cfg: Dict[str, Any], population: Population, rng: np.random.Generator
) -> pd.DataFrame:
    """One row per activation, carrying internal plan state only."""
    frames: List[pd.DataFrame] = []
    for _, agent in population.private.iterrows():
        frame = _plan_one_agent(cfg, agent, population.calendar, rng)
        if len(frame):
            frames.append(frame)
    plan = pd.concat(frames, ignore_index=True)
    flags = plan[list(FLAG_COLUMNS)].to_numpy()
    threshold = int(cfg["legitimate_lookalikes"]["min_flags_for_ambiguous"])
    plan["is_ambiguous"] = np.where(
        plan["is_fraudulent"], plan["careful"], flags.sum(axis=1) >= threshold
    )
    return plan


def engagement_specs(cfg: Dict[str, Any]) -> Dict[str, Any]:
    legit = cfg["legit_behaviour"]["engagement"]
    typologies = cfg["typologies"]
    return {
        "legit_normal": legit["normal"],
        "legit_dormant": legit["dormant"],
        "legit_trial_lapse": legit["trial_lapse"],
        "fraud_ghost": typologies["ghost"]["engagement"],
        "fraud_sim_farming": typologies["sim_farming"]["engagement"],
        "fraud_collusion": typologies["collusion"]["engagement"],
        "fraud_payout_gaming": typologies["payout_gaming"]["engagement"],
    }


def decay_specs(cfg: Dict[str, Any]) -> Dict[str, Any]:
    legit = cfg["legit_behaviour"]["engagement_decay"]
    typologies = cfg["typologies"]
    return {
        "legit_normal": legit["normal"],
        "legit_dormant": legit["dormant"],
        "legit_trial_lapse": legit["trial_lapse"],
        "fraud_ghost": typologies["ghost"]["engagement_decay"],
        "fraud_sim_farming": typologies["sim_farming"]["engagement_decay"],
        "fraud_collusion": typologies["collusion"]["engagement_decay"],
        "fraud_payout_gaming": typologies["payout_gaming"]["engagement_decay"],
    }


def distance_specs(cfg: Dict[str, Any]) -> Dict[str, Any]:
    typologies = cfg["typologies"]
    return {
        "legit_mobile": cfg["legit_behaviour"]["distance_km"],
        "legit_fixed_site": cfg["legitimate_lookalikes"]["fixed_site_distance_km"],
        "fraud_ghost": typologies["ghost"]["distance_km"],
        "fraud_sim_farming": typologies["sim_farming"]["distance_km"],
        "fraud_collusion": typologies["collusion"]["distance_km"],
        "fraud_payout_gaming": cfg["legit_behaviour"]["distance_km"],
    }


def sim_age_specs(cfg: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "standard": cfg["legit_behaviour"]["sim_age_days"],
        "same_day": cfg["legitimate_lookalikes"]["same_day_sim_age_days"],
        "farm": cfg["typologies"]["sim_farming"]["sim_age_days"],
    }


def hour_specs(cfg: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "standard": cfg["legit_behaviour"]["submission_hour"],
        "fraud_ghost": cfg["typologies"]["ghost"]["submission_hour"],
        "fraud_sim_farming": cfg["typologies"]["sim_farming"]["submission_hour"],
    }


def spread_specs(cfg: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "standard": cfg["legit_behaviour"]["intra_day_spread_hours"],
        "honest_burst": cfg["legitimate_lookalikes"]["burst_intra_day_spread_hours"],
        "farm_burst": cfg["typologies"]["sim_farming"]["burst_window_hours"],
    }


def complaint_specs(cfg: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "standard": cfg["legit_behaviour"]["complaint_daily_prob"],
        "fraud_ghost": cfg["typologies"]["ghost"]["complaint_daily_prob"],
        "fraud_collusion": cfg["typologies"]["collusion"]["complaint_daily_prob"],
    }


def hazard_specs(cfg: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "standard": cfg["legit_behaviour"]["sim_deactivation_hazard"],
        "fraud_ghost": cfg["typologies"]["ghost"]["sim_deactivation_hazard"],
    }


def acceptance_latency_specs(cfg: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "standard": cfg["legit_behaviour"]["acceptance_latency_minutes"],
        "batch": cfg["legitimate_lookalikes"]["batch_acceptance_latency_minutes"],
        "held": cfg["typologies"]["payout_gaming"]["acceptance_latency_minutes"],
    }


def submission_latency_specs(cfg: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "standard": cfg["legit_behaviour"]["submission_latency_minutes"],
        "fast_honest": cfg["legitimate_lookalikes"]["fast_submission_latency_minutes"],
        "event_backlog": cfg["legitimate_lookalikes"]["event_backlog_submission_latency_minutes"],
        "fraud_ghost": cfg["typologies"]["ghost"]["submission_latency_minutes"],
        "fraud_sim_farming": cfg["typologies"]["sim_farming"]["submission_latency_minutes"],
    }


def mimic_mask(
    careful: np.ndarray, blend: np.ndarray, rng: np.random.Generator
) -> np.ndarray:
    """Per-dimension decision that a careful fraud row imitates ordinary behaviour."""
    return careful & (rng.random(len(careful)) < blend)


def apply_mimicry(
    profiles: np.ndarray, mimic: np.ndarray, fallback: str
) -> np.ndarray:
    return np.where(mimic, fallback, profiles)
