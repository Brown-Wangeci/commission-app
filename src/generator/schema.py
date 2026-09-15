"""Separation of the observable event log from the generator's internal state.

These are two distinct objects on purpose. ObservableLog holds only what the
platform would actually record. InternalState holds the label and the hidden
variables that drove generation. Feature code is only ever handed an
ObservableLog, so it cannot read the label even by accident.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator

import pandas as pd

INTERNAL_COLUMNS = frozenset(
    {
        "is_fraudulent",
        "fraud_typology",
        "ring_id",
        "mode",
        "careful",
        "honesty_type",
        "engagement",
        "situational_flags",
        "is_ambiguous",
        "episode_id",
    }
)


class LeakageError(RuntimeError):
    """Raised when an internal generator variable reaches observable code."""


def assert_observable(frame: pd.DataFrame, name: str) -> None:
    leaked = INTERNAL_COLUMNS.intersection(frame.columns)
    if leaked:
        raise LeakageError(f"{name} carries internal generator columns: {sorted(leaked)}")


@dataclass(frozen=True)
class ObservableLog:
    """Everything the platform records, and nothing else."""

    activations: pd.DataFrame
    activity: pd.DataFrame
    agents: pd.DataFrame
    payout_calendar: pd.DataFrame

    def __post_init__(self) -> None:
        for name, frame in self._frames():
            assert_observable(frame, name)

    def _frames(self) -> Iterator[tuple[str, pd.DataFrame]]:
        yield "activations", self.activations
        yield "activity", self.activity
        yield "agents", self.agents
        yield "payout_calendar", self.payout_calendar


@dataclass(frozen=True)
class InternalState:
    """The label and the hidden variables. Never passed to feature code."""

    labels: pd.DataFrame

    def __post_init__(self) -> None:
        required = {"activation_id", "is_fraudulent", "fraud_typology"}
        missing = required.difference(self.labels.columns)
        if missing:
            raise ValueError(f"internal state is missing columns: {sorted(missing)}")
