"""Build an ObservableLog from a scoring request, and nothing else.

This is the only place the serving code touches raw event data before handing
it to src/generator/features.py::build_features -- the exact function used in
training. No feature is recomputed or reimplemented here; this module only
assembles the four frames ObservableLog expects.

`recent_activations` exists because the trailing-window T0 features (agent
velocity, device sharing, distinct devices, MSISDN repeats) are computed by
walking the full historical sequence, in time order, up to the scored row.
The caller is responsible for supplying enough history to cover every
configured window (see config/generator.yaml `features.*_window_*` and
`msisdn_history_days`); anything older than the longest window is harmless to
include and anything missing understates the true count.
"""

from __future__ import annotations

from typing import Any, Dict, List

import pandas as pd

from ..generator.features import build_features
from ..generator.schema import ObservableLog

DATETIME_COLUMNS = {
    "activations": (
        "job_assigned_timestamp", "job_accepted_timestamp",
        "timestamp_submitted", "sim_registration_date",
    ),
    "agents": ("agent_registration_date",),
    "payout_calendar": ("cycle_start_date", "cutoff_timestamp"),
}

ACTIVITY_COLUMNS = (
    "activation_id", "event_day", "customer_active_flag", "transaction_count",
    "topup_amount", "usage_minutes", "support_contact_flag",
    "complaint_or_refund_flag", "sim_active_flag",
)

# dtypes for the empty case (mode="t0", no downstream_activity yet). An empty
# frame built with the default `object` dtype breaks _t7_features downstream:
# `log[log["customer_active_flag"]]` on an all-object, all-empty boolean
# column drops every column instead of returning an empty-but-typed frame.
# Real, non-empty activity rows are unaffected by this and keep their own
# inferred dtypes.
ACTIVITY_DTYPES = {
    "activation_id": "object",
    "event_day": "int64",
    "customer_active_flag": "bool",
    "transaction_count": "int64",
    "topup_amount": "float64",
    "usage_minutes": "float64",
    "support_contact_flag": "bool",
    "complaint_or_refund_flag": "bool",
    "sim_active_flag": "bool",
}


def _frame(records: List[Dict[str, Any]], datetime_columns: tuple) -> pd.DataFrame:
    frame = pd.DataFrame.from_records(records)
    for column in datetime_columns:
        if column in frame.columns:
            # format="ISO8601" (rather than letting pandas guess a fixed format
            # from the first value) copes with mixed fractional-second
            # precision across rows, which plain to_datetime does not.
            frame[column] = pd.to_datetime(frame[column], format="ISO8601")
    return frame


def build_observable_log(
    activation: Dict[str, Any],
    recent_activations: List[Dict[str, Any]],
    agents: List[Dict[str, Any]],
    payout_calendar: List[Dict[str, Any]],
    downstream_activity: List[Dict[str, Any]],
) -> ObservableLog:
    """Assemble exactly the four frames build_features expects.

    The scored activation is appended to recent_activations, matching how the
    training pipeline's `activations` table holds every activation together;
    build_features re-sorts by timestamp_submitted internally, so the order
    passed in here does not matter.
    """
    activations = _frame([*recent_activations, activation], DATETIME_COLUMNS["activations"])
    agents_frame = _frame(agents, DATETIME_COLUMNS["agents"])
    payout_frame = _frame(payout_calendar, DATETIME_COLUMNS["payout_calendar"])

    activity_rows = [
        {**row, "activation_id": activation["activation_id"]} for row in downstream_activity
    ]
    activity_frame = (
        pd.DataFrame.from_records(activity_rows) if activity_rows
        else pd.DataFrame({name: pd.Series(dtype=dtype) for name, dtype in ACTIVITY_DTYPES.items()})
    )

    return ObservableLog(
        activations=activations,
        activity=activity_frame,
        agents=agents_frame,
        payout_calendar=payout_frame,
    )


def score_row_features(
    activation: Dict[str, Any],
    recent_activations: List[Dict[str, Any]],
    agents: List[Dict[str, Any]],
    payout_calendar: List[Dict[str, Any]],
    downstream_activity: List[Dict[str, Any]],
    gen_cfg: Dict[str, Any],
) -> pd.Series:
    """The T0+T7 feature row for exactly the scored activation.

    Calls build_features on the whole assembled log (which may include
    history rows purely for their trailing-window contribution) and returns
    only the row matching the scored activation_id.
    """
    log = build_observable_log(activation, recent_activations, agents, payout_calendar, downstream_activity)
    features = build_features(log, gen_cfg)
    combined = features.combined()
    matches = combined[combined["activation_id"] == activation["activation_id"]]
    if matches.empty:
        raise ValueError(
            f"activation_id {activation['activation_id']!r} did not survive feature computation"
        )
    if len(matches) > 1:
        raise ValueError(
            f"activation_id {activation['activation_id']!r} appears more than once across "
            "recent_activations and the scored activation"
        )
    return matches.iloc[0]
