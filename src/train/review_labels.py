"""Load the labelled records reviewers leave behind (DR-10).

The dataset is written by `app/scripts/export-labels.ts` as a folder holding
`labels.jsonl` and `manifest.json`. One row is one reviewed submission: the
feature vector the service actually scored, stored with the decision, and the
final human decision as the label (1 refused, 0 approved).

Nothing here recomputes a feature. The export carries no personal data, and
this module refuses a file that has grown a field the export does not
declare, so a change on the application side cannot quietly bring one in.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List

import numpy as np
import pandas as pd

from ..generator import config as config_module

DATASET_NAME = "ledgerfield-review-labels"
LABELS_FILENAME = "labels.jsonl"
MANIFEST_FILENAME = "manifest.json"

# Exactly the fields app/src/lib/labels/export.ts declares. A file carrying
# anything else is refused rather than silently loaded.
EXPECTED_FIELDS = (
    "row",
    "agent_group",
    "mode",
    "feature_set",
    "model_version",
    "model_probability",
    "model_band",
    "release_threshold",
    "reject_threshold",
    "scored_at",
    "decided_at",
    "decision",
    "label",
    "reviewer_role",
    "open_reason",
    "features",
)

LABEL_FOR = {"approved": 0, "refused": 1}


class ReviewLabelError(RuntimeError):
    """Raised when an export is missing, malformed, or not what its manifest says."""


@dataclass(frozen=True)
class ReviewLabels:
    """One export, already checked against its manifest."""

    version: str
    path: Path
    manifest: Dict[str, Any]
    frame: pd.DataFrame

    def for_feature_set(self, feature_set: str, feature_names: tuple) -> "ReviewLabels":
        """The rows scored with this feature set, and only those.

        A submission escalated at T0 was scored on the T0 features alone, so it
        cannot train a T7 model: the nine downstream features do not exist for
        it, and inventing them would be making up evidence.
        """
        kept = self.frame[self.frame["feature_set"] == feature_set].reset_index(drop=True)
        missing = [name for name in feature_names if name not in kept.columns]
        if len(kept) > 0 and missing:
            raise ReviewLabelError(
                f"export {self.version}: rows for feature set {feature_set} are missing {missing}"
            )
        return ReviewLabels(self.version, self.path, self.manifest, kept)

    def matrix(self, feature_names: tuple) -> pd.DataFrame:
        return self.frame[list(feature_names)].astype(float)

    @property
    def labels(self) -> np.ndarray:
        return self.frame["label"].to_numpy().astype(int)

    @property
    def groups(self) -> np.ndarray:
        """Opaque agent groups, so a split can keep one agent's rows together."""
        return self.frame["agent_group"].to_numpy().astype(int)

    def __len__(self) -> int:
        return len(self.frame)


def _check_manifest(manifest: Dict[str, Any], raw: str, version: str) -> None:
    if manifest.get("dataset") != DATASET_NAME:
        raise ReviewLabelError(f"{version}: not a {DATASET_NAME} export")
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    if manifest.get("sha256") != digest:
        raise ReviewLabelError(f"{version}: labels.jsonl does not match the sha256 in its manifest")
    if int(manifest.get("rows", -1)) < 0:
        raise ReviewLabelError(f"{version}: manifest has no row count")
    if manifest.get("labelMeaning") != LABEL_FOR:
        raise ReviewLabelError(f"{version}: manifest maps decisions to labels as {manifest.get('labelMeaning')}, not {LABEL_FOR}")


def _rows_to_frame(rows: List[Dict[str, Any]], version: str) -> pd.DataFrame:
    """One row per record, with the feature vector flattened into columns."""
    flattened = []
    for row in rows:
        unexpected = set(row) - set(EXPECTED_FIELDS)
        if unexpected:
            raise ReviewLabelError(f"{version}: row {row.get('row')} carries unexpected field(s) {sorted(unexpected)}")
        if row["decision"] not in LABEL_FOR or row["label"] != LABEL_FOR[row["decision"]]:
            raise ReviewLabelError(f"{version}: row {row.get('row')} labels {row['decision']} as {row['label']}")
        features = row["features"]
        if not features or not all(isinstance(value, (int, float)) for value in features.values()):
            raise ReviewLabelError(f"{version}: row {row.get('row')} has no usable feature vector")
        flattened.append({**{name: row[name] for name in EXPECTED_FIELDS if name != "features"}, **features})
    frame = pd.DataFrame(flattened)
    if len(frame) > 0:
        frame["decided_at"] = pd.to_datetime(frame["decided_at"], format="ISO8601", utc=True)
        frame["scored_at"] = pd.to_datetime(frame["scored_at"], format="ISO8601", utc=True)
    return frame


def load_export(path: Path) -> ReviewLabels:
    """Load one export folder, checking it against its own manifest."""
    folder = Path(path)
    manifest_path = folder / MANIFEST_FILENAME
    labels_path = folder / LABELS_FILENAME
    for required in (manifest_path, labels_path):
        if not required.is_file():
            raise ReviewLabelError(f"{folder}: {required.name} is missing")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    raw = labels_path.read_text(encoding="utf-8")
    version = str(manifest.get("version", folder.name))
    _check_manifest(manifest, raw, version)
    rows = [json.loads(line) for line in raw.splitlines() if line.strip()]
    if len(rows) != int(manifest["rows"]):
        raise ReviewLabelError(f"{version}: manifest says {manifest['rows']} rows, file holds {len(rows)}")
    return ReviewLabels(version=version, path=folder, manifest=manifest, frame=_rows_to_frame(rows, version))


def latest_export(root: Path) -> Path:
    """The newest export folder under `root`, by name, which sorts by time."""
    folder = Path(root)
    if not folder.is_dir():
        raise ReviewLabelError(
            f"{folder} does not exist; run `npx tsx scripts/export-labels.ts` from app/ first"
        )
    versions = sorted(child for child in folder.iterdir() if (child / MANIFEST_FILENAME).is_file())
    if not versions:
        raise ReviewLabelError(f"no export with a {MANIFEST_FILENAME} under {folder}")
    return versions[-1]


def export_root(retrain_cfg: Dict[str, Any]) -> Path:
    """Where the application writes its exports, from config/retraining.yaml."""
    return config_module.REPO_ROOT / str(retrain_cfg["retraining"]["export_dir"])
