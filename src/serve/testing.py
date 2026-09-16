"""Build full ScoreRequest-shaped payloads from the data on disk.

Not part of the deployed service: this module reads data/*.parquet directly,
which exists only in a development checkout with a generated dataset. Used
by tests/test_serve.py and scripts/smoke_test_service.py so both work from
the same real historical activations rather than hand-written fixtures.
"""

from __future__ import annotations

from typing import Any, Dict, List

import numpy as np
import pandas as pd

from ..eval.cv import derived_seed
from ..generator import config as config_module
from ..train import data as data_module
from ..train.production import PRODUCTION_SEED_MARKER, _agent_split
from . import artifact as artifact_module

DATA_DIR = config_module.REPO_ROOT / "data"

ACTIVATION_COLUMNS = (
    "activation_id", "agent_id", "job_id", "client_business_id",
    "job_assigned_timestamp", "job_accepted_timestamp", "timestamp_submitted",
    "device_id", "device_os", "app_version", "ip_geolocation_region", "network_type",
    "submission_gps_lat", "submission_gps_lon", "customer_msisdn_hash",
    "sim_registration_date", "activation_method", "proof_of_activation_hash",
    "escrow_amount", "commission_rate",
)
AGENT_COLUMNS = ("agent_id", "agent_registration_date", "agent_home_lat", "agent_home_lon")
PAYOUT_COLUMNS = ("cycle_id", "cycle_start_date", "cutoff_timestamp")
ACTIVITY_COLUMNS = (
    "event_day", "customer_active_flag", "transaction_count", "topup_amount",
    "usage_minutes", "support_contact_flag", "complaint_or_refund_flag", "sim_active_flag",
)


def _jsonable(value: Any) -> Any:
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        return None if np.isnan(value) else float(value)
    if isinstance(value, np.bool_):
        return bool(value)
    if isinstance(value, float) and np.isnan(value):
        return None
    return value


def _records(frame: pd.DataFrame, columns: tuple) -> List[Dict[str, Any]]:
    return [
        {column: _jsonable(row[column]) for column in columns}
        for row in frame[list(columns)].to_dict(orient="records")
    ]


def load_frames() -> Dict[str, pd.DataFrame]:
    return {
        "activations": pd.read_parquet(DATA_DIR / "activations.parquet"),
        "agents": pd.read_parquet(DATA_DIR / "agents.parquet"),
        "payout_calendar": pd.read_parquet(DATA_DIR / "payout_calendar.parquet"),
        "activity": pd.read_parquet(DATA_DIR / "activity_log.parquet"),
    }


def build_request_payload(
    activation_id: str, frames: Dict[str, pd.DataFrame], history_days: int, mode: str = "t7"
) -> Dict[str, Any]:
    """A full ScoreRequest payload for one activation, built from data on disk.

    `history_days` should cover the largest trailing window configured in
    config/generator.yaml (features.msisdn_history_days), so every T0
    trailing-window feature reproduces exactly what training computed.

    `mode="t0"` omits downstream_activity, matching what is actually known
    at submission time; `mode="t7"` (default) includes the full log, as at
    hold-close.
    """
    activations = frames["activations"]
    target = activations.loc[activations["activation_id"] == activation_id].iloc[0]
    cutoff = target["timestamp_submitted"] - pd.Timedelta(days=history_days)
    history = activations[
        (activations["timestamp_submitted"] >= cutoff)
        & (activations["timestamp_submitted"] < target["timestamp_submitted"])
    ]
    downstream = (
        _records(
            frames["activity"].loc[frames["activity"]["activation_id"] == activation_id],
            ACTIVITY_COLUMNS,
        )
        if mode == "t7" else []
    )

    return {
        "mode": mode,
        "activation": {column: _jsonable(target[column]) for column in ACTIVATION_COLUMNS},
        "agents": _records(frames["agents"], AGENT_COLUMNS),
        "recent_activations": _records(history, ACTIVATION_COLUMNS),
        "payout_calendar": _records(frames["payout_calendar"], PAYOUT_COLUMNS),
        "downstream_activity": downstream,
    }


def position_of(keys: pd.DataFrame, activation_id: str) -> int:
    return int(keys.index[keys["activation_id"] == activation_id][0])


def held_out_calibration_index(dataset: data_module.Dataset, model_cfg: Dict[str, Any]) -> np.ndarray:
    """The rows the deployed artifact's tree never saw.

    Recomputes the same deterministic agent-grouped split
    src.train.production used to build the artifact -- no retraining, just
    the same seeded index calculation, so "held out" means genuinely unseen
    by the model that is being tested.
    """
    cv_cfg = model_cfg["cross_validation"]
    base_seed = int(cv_cfg["cv_seed"])
    all_rows = np.arange(len(dataset.keys))
    _, calibration_index = _agent_split(
        dataset.keys, dataset.labels, all_rows,
        float(cv_cfg["calibration_agent_fraction"]),
        derived_seed(base_seed, PRODUCTION_SEED_MARKER, 3),
    )
    return calibration_index


def select_smoke_test_ids(
    artifact: artifact_module.LoadedArtifact,
    dataset: data_module.Dataset,
    calibration_index: np.ndarray,
    count: int = 20,
) -> List[str]:
    """`count` held-out activation ids, spanning all three bands where possible."""
    held_matrix = dataset.features[list(artifact.features)].iloc[calibration_index]
    raw = artifact.booster.predict_proba(held_matrix)[:, 1]
    probability = artifact.calibrate(raw)
    bands = np.where(
        probability <= artifact.release_threshold, "auto_release",
        np.where(probability <= artifact.reject_threshold, "review", "reject"),
    )
    ids = dataset.keys["activation_id"].to_numpy()[calibration_index]
    frame = pd.DataFrame({"activation_id": ids, "band": bands})

    per_band = max(1, count // 3)
    picked: List[str] = []
    for band in ("reject", "review", "auto_release"):
        picked.extend(frame.loc[frame["band"] == band, "activation_id"].head(per_band).tolist())
    if len(picked) < count:
        remaining = count - len(picked)
        extra = frame.loc[
            (frame["band"] == "auto_release") & (~frame["activation_id"].isin(picked)), "activation_id"
        ].head(remaining)
        picked.extend(extra.tolist())
    return picked[:count]
