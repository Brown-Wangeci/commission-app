"""Request and response models for the scoring service.

Field types match docs/data_dictionary.md sections 2a-2d exactly. `extra`
requests are rejected rather than silently ignored, so a caller sending a
misspelled or internal field finds out immediately (Part B4).
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ActivationEvent(BaseModel):
    """Data dictionary section 2a: one activation submission event."""

    model_config = ConfigDict(extra="forbid")

    activation_id: str
    agent_id: str
    job_id: str
    client_business_id: str
    job_assigned_timestamp: datetime
    job_accepted_timestamp: datetime
    timestamp_submitted: datetime
    device_id: str
    device_os: str
    app_version: str
    ip_geolocation_region: str
    network_type: Literal["cellular", "wifi"]
    submission_gps_lat: float = Field(ge=-90.0, le=90.0)
    submission_gps_lon: float = Field(ge=-180.0, le=180.0)
    customer_msisdn_hash: str
    sim_registration_date: datetime
    activation_method: Literal["qr_scan", "manual_entry"]
    proof_of_activation_hash: str | None = None
    escrow_amount: float = Field(gt=0.0)
    commission_rate: float = Field(gt=0.0, le=1.0)

    @model_validator(mode="after")
    def _timestamps_are_ordered(self) -> "ActivationEvent":
        if self.job_accepted_timestamp < self.job_assigned_timestamp:
            raise ValueError("job_accepted_timestamp precedes job_assigned_timestamp")
        if self.timestamp_submitted < self.job_accepted_timestamp:
            raise ValueError("timestamp_submitted precedes job_accepted_timestamp")
        if self.sim_registration_date > self.timestamp_submitted:
            raise ValueError("sim_registration_date is after timestamp_submitted")
        return self


class AgentRecord(BaseModel):
    """Data dictionary section 2b: one agent register row."""

    model_config = ConfigDict(extra="forbid")

    agent_id: str
    agent_registration_date: datetime
    agent_home_lat: float = Field(ge=-90.0, le=90.0)
    agent_home_lon: float = Field(ge=-180.0, le=180.0)


class PayoutCycle(BaseModel):
    """Data dictionary section 2c: one payout cycle calendar row."""

    model_config = ConfigDict(extra="forbid")

    cycle_id: int = Field(ge=0)
    cycle_start_date: datetime
    cutoff_timestamp: datetime

    @model_validator(mode="after")
    def _cutoff_after_start(self) -> "PayoutCycle":
        if self.cutoff_timestamp < self.cycle_start_date:
            raise ValueError("cutoff_timestamp precedes cycle_start_date")
        return self


class DownstreamActivityDay(BaseModel):
    """Data dictionary section 2d: one day of the downstream activity log."""

    model_config = ConfigDict(extra="forbid")

    event_day: int = Field(ge=0, le=30)
    customer_active_flag: bool
    transaction_count: int = Field(ge=0)
    topup_amount: float = Field(ge=0.0)
    usage_minutes: float = Field(ge=0.0)
    support_contact_flag: bool
    complaint_or_refund_flag: bool
    sim_active_flag: bool


class ScoreRequest(BaseModel):
    """The full context needed to reconstruct an ObservableLog for one activation.

    `mode` is required, with no default, so a caller cannot get the wrong
    model by omission: "t0" scores at submission time from only the
    submission event, agents, recent_activations and payout_calendar, and
    must not include downstream_activity, since that data cannot exist yet
    at that decision point; "t7" scores at hold-close and requires it.
    """

    model_config = ConfigDict(extra="forbid")

    mode: Literal["t0", "t7"]
    activation: ActivationEvent
    agents: list[AgentRecord] = Field(min_length=1)
    recent_activations: list[ActivationEvent] = Field(default_factory=list)
    payout_calendar: list[PayoutCycle] = Field(min_length=1)
    downstream_activity: list[DownstreamActivityDay] = Field(default_factory=list)

    @model_validator(mode="after")
    def _internally_consistent(self) -> "ScoreRequest":
        agent_ids = {a.agent_id for a in self.agents}
        if self.activation.agent_id not in agent_ids:
            raise ValueError(
                f"agents does not include the scored activation's agent_id "
                f"{self.activation.agent_id!r}"
            )
        for prior in self.recent_activations:
            if prior.timestamp_submitted > self.activation.timestamp_submitted:
                raise ValueError(
                    "recent_activations must not be submitted after the scored activation"
                )
        if self.mode == "t7" and not self.downstream_activity:
            raise ValueError("mode 't7' requires a non-empty downstream_activity")
        if self.mode == "t0" and self.downstream_activity:
            raise ValueError(
                "mode 't0' scores at submission time and must not include "
                "downstream_activity, which cannot exist yet at that decision point"
            )
        return self


class ReasonContribution(BaseModel):
    feature: str
    is_agent_level: bool
    direction: Literal["raises", "lowers"]
    shap_value: float
    description: str


class ScoreResponse(BaseModel):
    activation_id: str
    mode: Literal["t0", "t7"]
    feature_set: str
    model_version: str
    raw_score: float
    calibrated_probability: float
    band: Literal["auto_release", "review", "reject"]
    release_threshold: float
    reject_threshold: float
    top_reasons: list[ReasonContribution]
    # Every feature the model scored, by name, exactly as it went into the
    # model. Returned so the caller can store it with its decision record
    # (app issue #43); the same vector is already kept by /explain.
    feature_vector: dict[str, float]
    scored_at: datetime


class HealthResponse(BaseModel):
    status: Literal["ok", "unavailable"]
    model_version: str | None
    t0_model_version: str | None
    loaded: bool


class ExplainRecord(BaseModel):
    scored_at: str
    mode: str
    feature_set: str
    model_version: str
    config_hash: str
    feature_vector: dict[str, float]
    raw_score: float
    calibrated_probability: float
    band: str
    release_threshold: float
    reject_threshold: float
    top_reasons: list[ReasonContribution]


class ExplainResponse(BaseModel):
    """Every stored record for this activation, oldest first.

    An activation can be scored more than once -- typically "t0" at
    submission and "t7" once the hold window closes -- and the dispute flow
    needs to see the decision being revised, not just the latest one.
    """

    activation_id: str
    records: list[ExplainRecord]
