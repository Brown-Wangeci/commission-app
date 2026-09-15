"""T0 and T7 features, computed from the observable event log alone.

This module is handed an ObservableLog and nothing else. It has no reference
to the label, the typology, ring membership, or any other hidden generator
variable, and ObservableLog refuses to be constructed if such a column is
present. Every window length is read from configuration.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Any, Dict, Sequence

import numpy as np
import pandas as pd

from .schema import ObservableLog, assert_observable

T0_FEATURES = (
    "submission_latency_seconds",
    "job_acceptance_latency_seconds",
    "acceptance_to_submission_seconds",
    "distance_from_agent_home_km",
    "agent_tenure_days",
    "sim_age_at_activation_days",
    "agent_activation_velocity_1h",
    "agent_activation_velocity_24h",
    "device_activations_7d",
    "device_shared_agent_count_30d",
    "distinct_devices_used_30d",
    "customer_msisdn_prior_activation_count",
    "days_to_payout_cutoff",
    "ip_location_mismatch_flag",
    "activation_method_is_manual_entry",
    "proof_of_activation_missing_flag",
    "submission_hour_of_day",
    "network_type_is_cellular",
)

T7_FEATURES = (
    "customer_active_days_7d",
    "days_to_first_customer_activity",
    "transaction_count_7d",
    "topup_amount_total_7d",
    "usage_minutes_total_7d",
    "support_contact_count_7d",
    "complaint_or_refund_flag_7d",
    "sim_active_at_day7",
    "activity_dropoff_flag",
)

KEY_COLUMNS = ("activation_id", "agent_id", "timestamp_submitted")


@dataclass(frozen=True)
class FeatureMatrix:
    """Two named column groups plus the keys needed to split and join."""

    keys: pd.DataFrame
    t0: pd.DataFrame
    t7: pd.DataFrame

    def combined(self) -> pd.DataFrame:
        return pd.concat([self.keys, self.t0, self.t7], axis=1)

    @property
    def feature_names(self) -> list[str]:
        return list(self.t0.columns) + list(self.t7.columns)


def _trailing_count(keys: Sequence, times: np.ndarray, window: int) -> np.ndarray:
    """Number of earlier rows sharing the key within the trailing window."""
    history: dict[Any, list[int]] = defaultdict(list)
    cursors: dict[Any, int] = defaultdict(int)
    out = np.zeros(len(times), dtype=float)
    for i, (key, stamp) in enumerate(zip(keys, times)):
        seen = history[key]
        cursor = cursors[key]
        while cursor < len(seen) and seen[cursor] < stamp - window:
            cursor += 1
        cursors[key] = cursor
        out[i] = len(seen) - cursor
        seen.append(stamp)
    return out


def _trailing_distinct(
    keys: Sequence, values: Sequence, times: np.ndarray, window: int
) -> np.ndarray:
    """Distinct values seen for the key within the trailing window, current row included."""
    history: dict[Any, list[tuple[int, Any]]] = defaultdict(list)
    cursors: dict[Any, int] = defaultdict(int)
    tallies: dict[Any, Counter] = defaultdict(Counter)
    out = np.zeros(len(times), dtype=float)
    for i, (key, value, stamp) in enumerate(zip(keys, values, times)):
        seen = history[key]
        cursor = cursors[key]
        tally = tallies[key]
        while cursor < len(seen) and seen[cursor][0] < stamp - window:
            stale = seen[cursor][1]
            tally[stale] -= 1
            if tally[stale] == 0:
                del tally[stale]
            cursor += 1
        cursors[key] = cursor
        seen.append((stamp, value))
        tally[value] += 1
        out[i] = len(tally)
    return out


def _days_to_cutoff(submitted: pd.Series, payout_calendar: pd.DataFrame) -> np.ndarray:
    cutoffs = np.sort(payout_calendar["cutoff_timestamp"].to_numpy())
    spacing = np.median(np.diff(cutoffs)) if len(cutoffs) > 1 else np.timedelta64(1, "D")
    extended = np.append(cutoffs, cutoffs[-1] + spacing)
    stamps = submitted.to_numpy()
    index = np.searchsorted(extended, stamps, side="left")
    index = np.clip(index, 0, len(extended) - 1)
    delta = (extended[index] - stamps) / np.timedelta64(1, "D")
    return delta.astype(float)


def _implied_region(cfg: Dict[str, Any], lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    centers = cfg["population"]["urban_centers"]
    center_lat = np.array([c["lat"] for c in centers])
    center_lon = np.array([c["lon"] for c in centers])
    regions = np.array([c["region"] for c in centers])
    squared = (lat[:, None] - center_lat[None, :]) ** 2 + (lon[:, None] - center_lon[None, :]) ** 2
    return regions[np.argmin(squared, axis=1)]


def _t0_features(
    cfg: Dict[str, Any], activations: pd.DataFrame, agents: pd.DataFrame, payout_calendar: pd.DataFrame
) -> pd.DataFrame:
    feature_cfg = cfg["features"]
    frame = activations.merge(agents, on="agent_id", how="left")
    submitted = frame["timestamp_submitted"]
    stamps = submitted.to_numpy().astype("datetime64[ns]").astype(np.int64)
    hour_ns = np.int64(3_600_000_000_000)
    day_ns = hour_ns * 24

    out = pd.DataFrame(index=frame.index)
    out["submission_latency_seconds"] = (
        submitted - frame["job_assigned_timestamp"]
    ).dt.total_seconds()
    out["job_acceptance_latency_seconds"] = (
        frame["job_accepted_timestamp"] - frame["job_assigned_timestamp"]
    ).dt.total_seconds()
    out["acceptance_to_submission_seconds"] = (
        submitted - frame["job_accepted_timestamp"]
    ).dt.total_seconds()

    km_per_degree = float(cfg["geo"]["km_per_degree_latitude"])
    delta_lat = frame["submission_gps_lat"] - frame["agent_home_lat"]
    delta_lon = (frame["submission_gps_lon"] - frame["agent_home_lon"]) * np.cos(
        np.radians(frame["agent_home_lat"])
    )
    out["distance_from_agent_home_km"] = np.hypot(delta_lat, delta_lon) * km_per_degree

    out["agent_tenure_days"] = (
        submitted - frame["agent_registration_date"]
    ).dt.total_seconds() / (24 * 3600)
    out["sim_age_at_activation_days"] = (
        submitted - frame["sim_registration_date"]
    ).dt.total_seconds() / (24 * 3600)

    agent_ids = frame["agent_id"].to_numpy()
    device_ids = frame["device_id"].to_numpy()
    out["agent_activation_velocity_1h"] = (
        _trailing_count(agent_ids, stamps, hour_ns * int(feature_cfg["velocity_window_hours"])) + 1
    )
    out["agent_activation_velocity_24h"] = (
        _trailing_count(agent_ids, stamps, hour_ns * int(feature_cfg["velocity_window_hours_long"]))
        + 1
    )
    out["device_activations_7d"] = (
        _trailing_count(device_ids, stamps, day_ns * int(feature_cfg["device_window_days_short"]))
        + 1
    )
    out["device_shared_agent_count_30d"] = _trailing_distinct(
        device_ids, agent_ids, stamps, day_ns * int(feature_cfg["device_window_days_long"])
    )
    out["distinct_devices_used_30d"] = _trailing_distinct(
        agent_ids, device_ids, stamps, day_ns * int(feature_cfg["device_window_days_long"])
    )
    out["customer_msisdn_prior_activation_count"] = _trailing_count(
        frame["customer_msisdn_hash"].to_numpy(),
        stamps,
        day_ns * int(feature_cfg["msisdn_history_days"]),
    )

    out["days_to_payout_cutoff"] = _days_to_cutoff(submitted, payout_calendar)
    implied = _implied_region(
        cfg, frame["submission_gps_lat"].to_numpy(), frame["submission_gps_lon"].to_numpy()
    )
    out["ip_location_mismatch_flag"] = (
        implied != frame["ip_geolocation_region"].to_numpy()
    ).astype(float)
    out["activation_method_is_manual_entry"] = (
        frame["activation_method"] == "manual_entry"
    ).astype(float)
    out["proof_of_activation_missing_flag"] = frame["proof_of_activation_hash"].isna().astype(float)
    out["submission_hour_of_day"] = submitted.dt.hour + submitted.dt.minute / 60.0
    out["network_type_is_cellular"] = (frame["network_type"] == "cellular").astype(float)
    return out[list(T0_FEATURES)]


def _t7_features(
    cfg: Dict[str, Any], activations: pd.DataFrame, activity: pd.DataFrame
) -> pd.DataFrame:
    window = int(cfg["features"]["t7_window_days"])
    early_days = int(cfg["features"]["dropoff_early_days"])
    log = activity[activity["event_day"] <= window]

    grouped = log.groupby("activation_id")
    summary = pd.DataFrame(
        {
            "customer_active_days_7d": grouped["customer_active_flag"].sum(),
            "transaction_count_7d": grouped["transaction_count"].sum(),
            "topup_amount_total_7d": grouped["topup_amount"].sum(),
            "usage_minutes_total_7d": grouped["usage_minutes"].sum(),
            "support_contact_count_7d": grouped["support_contact_flag"].sum(),
            "complaint_or_refund_flag_7d": grouped["complaint_or_refund_flag"].max(),
        }
    )

    active = log[log["customer_active_flag"]]
    first_active = active.groupby("activation_id")["event_day"].min()
    summary["days_to_first_customer_activity"] = first_active
    summary["days_to_first_customer_activity"] = summary[
        "days_to_first_customer_activity"
    ].fillna(window + 1)

    final_day = log[log["event_day"] == window].set_index("activation_id")["sim_active_flag"]
    summary["sim_active_at_day7"] = final_day

    early = active[active["event_day"] < early_days].groupby("activation_id").size()
    late = active[active["event_day"] >= early_days].groupby("activation_id").size()
    summary["activity_dropoff_flag"] = (
        summary.index.isin(early.index) & ~summary.index.isin(late.index)
    )

    summary = summary.reindex(activations["activation_id"])
    summary = summary.astype(float).fillna(0.0)
    summary.index = activations.index
    return summary[list(T7_FEATURES)]


def build_features(log: ObservableLog, cfg: Dict[str, Any]) -> FeatureMatrix:
    """Build both feature groups. The only input is the observable log."""
    if not isinstance(log, ObservableLog):
        raise TypeError("build_features accepts an ObservableLog and nothing else")
    assert_observable(log.activations, "activations")
    assert_observable(log.activity, "activity")

    activations = log.activations.sort_values("timestamp_submitted", kind="stable").reset_index(
        drop=True
    )
    keys = activations[list(KEY_COLUMNS)].copy()
    t0 = _t0_features(cfg, activations, log.agents, log.payout_calendar)
    t7 = _t7_features(cfg, activations, log.activity)
    return FeatureMatrix(keys=keys, t0=t0, t7=t7)
