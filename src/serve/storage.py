"""SQLite persistence for prediction records (Part C).

Plain SQL, no ORM: the table is small and the queries are simple lookups, so
an ORM dependency would add weight without adding safety. The schema is
written to port cleanly to PostgreSQL --

  - `id` is a TEXT uuid, not an autoincrementing rowid, so it needs no
    dialect-specific SERIAL/IDENTITY syntax;
  - every other column is a portable type (TEXT, REAL, INTEGER);
  - `feature_vector` and `top_reasons` are JSON stored as TEXT; in Postgres
    the column type becomes JSONB with no change to the data or the
    application code that reads it;
  - `scored_at` is stored as an ISO-8601 string; in Postgres it becomes
    TIMESTAMPTZ by parsing the same strings, since ISO-8601 is what
    TIMESTAMPTZ's text input accepts.

No SQLite-only feature (WITHOUT ROWID, dynamic typing tricks) is used.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, Optional
from uuid import uuid4

if TYPE_CHECKING:
    from .service import ScoredActivation

SCHEMA = """
CREATE TABLE IF NOT EXISTS predictions (
    id TEXT PRIMARY KEY,
    activation_id TEXT NOT NULL,
    scored_at TEXT NOT NULL,
    model_version TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    feature_vector TEXT NOT NULL,
    raw_score REAL NOT NULL,
    calibrated_probability REAL NOT NULL,
    band TEXT NOT NULL,
    release_threshold REAL NOT NULL,
    reject_threshold REAL NOT NULL,
    top_reasons TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_predictions_activation_id ON predictions (activation_id);
CREATE INDEX IF NOT EXISTS idx_predictions_scored_at ON predictions (scored_at);
"""

_INSERT = """
INSERT INTO predictions (
    id, activation_id, scored_at, model_version, config_hash, feature_vector,
    raw_score, calibrated_probability, band, release_threshold, reject_threshold, top_reasons
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
"""


class Storage:
    """One connection per process; SQLite handles the file locking."""

    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(str(path), check_same_thread=False)
        self._connection.executescript(SCHEMA)
        self._connection.commit()

    def save(self, scored: "ScoredActivation", config_hash: str) -> str:
        record_id = str(uuid4())
        self._connection.execute(
            _INSERT,
            (
                record_id,
                scored.activation_id,
                scored.scored_at.isoformat(),
                scored.model_version,
                config_hash,
                json.dumps(scored.feature_vector),
                scored.raw_score,
                scored.calibrated_probability,
                scored.band,
                scored.release_threshold,
                scored.reject_threshold,
                json.dumps([reason.__dict__ for reason in scored.top_reasons]),
            ),
        )
        self._connection.commit()
        return record_id

    def latest_for_activation(self, activation_id: str) -> Optional[Dict[str, Any]]:
        """The most recently scored record for this activation_id, or None.

        Multiple records can exist if an activation was scored more than
        once (e.g. rescored after a data correction); the dispute flow gets
        the most recent decision.
        """
        cursor = self._connection.execute(
            "SELECT * FROM predictions WHERE activation_id = ? ORDER BY scored_at DESC LIMIT 1",
            (activation_id,),
        )
        row = cursor.fetchone()
        if row is None:
            return None
        columns = [description[0] for description in cursor.description]
        record = dict(zip(columns, row))
        record["feature_vector"] = json.loads(record["feature_vector"])
        record["top_reasons"] = json.loads(record["top_reasons"])
        return record

    def close(self) -> None:
        self._connection.close()
