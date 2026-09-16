"""E1: start the service, score twenty held-out activations in both modes,
and print the responses.

Usage: .venv/Scripts/python.exe scripts/smoke_test_service.py

Runs the FastAPI app in-process via TestClient (no separate server process
needed), so this can run in CI without binding a port.

Each of the twenty held-out activations is scored twice: once in mode "t0"
(only what is known at submission) and once in mode "t7" (the full
downstream log, as at hold-close). The two bands are compared per record;
disagreements are counted, and a T0 auto-release followed by a T7 reject is
flagged specifically, since that is the case where a payout has already
been made before the model that would have refused it ever sees the case.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from src.generator import config as config_module  # noqa: E402
from src.serve import artifact as artifact_module  # noqa: E402
from src.serve import testing as serve_testing  # noqa: E402
from src.serve.app import app  # noqa: E402
from src.train import data as data_module  # noqa: E402

COUNT = 20


def main() -> None:
    model_cfg = config_module.load_config(config_module.MODEL_CONFIG)
    gen_cfg = config_module.load_config(config_module.GENERATOR_CONFIG)
    t7_artifact = artifact_module.load_artifact()  # chosen model, default version
    dataset = data_module.load_dataset()
    calibration_index = serve_testing.held_out_calibration_index(dataset, model_cfg)
    activation_ids = serve_testing.select_smoke_test_ids(
        t7_artifact, dataset, calibration_index, count=COUNT
    )
    print(f"scoring {len(activation_ids)} held-out activations "
          f"(unseen by either artifact's tree fit) in both modes\n")

    frames = serve_testing.load_frames()
    history_days = int(gen_cfg["features"]["msisdn_history_days"])

    rows = []
    with TestClient(app) as client:
        health = client.get("/health")
        print(f"GET /health -> {health.status_code} {health.json()}\n")

        for activation_id in activation_ids:
            result = {"activation_id": activation_id}
            for mode in ("t0", "t7"):
                payload = serve_testing.build_request_payload(
                    activation_id, frames, history_days, mode=mode
                )
                response = client.post("/score", json=payload)
                if response.status_code != 200:
                    print(f"{activation_id} [{mode}]: HTTP {response.status_code} {response.text}")
                    result[mode] = None
                    continue
                body = response.json()
                result[mode] = body
            rows.append(result)

            explain = client.get(f"/explain/{activation_id}")
            assert explain.status_code == 200, f"explain lookup failed for {activation_id}"
            record_count = len(explain.json()["records"])
            assert record_count == 2, f"expected 2 stored records for {activation_id}, got {record_count}"

    header = f"{'activation_id':<16}{'t0 band':<14}{'t0 p':<8}{'t7 band':<14}{'t7 p':<8}"
    print(header)
    print("-" * len(header))

    disagreements = 0
    release_then_reject = []
    for row in rows:
        t0, t7 = row.get("t0"), row.get("t7")
        if t0 is None or t7 is None:
            continue
        agree = t0["band"] == t7["band"]
        if not agree:
            disagreements += 1
        flag = ""
        if t0["band"] == "auto_release" and t7["band"] == "reject":
            release_then_reject.append(row["activation_id"])
            flag = "  <-- T0 released, T7 would reject: payout already made"
        print(
            f"{row['activation_id']:<16}"
            f"{t0['band']:<14}{t0['calibrated_probability']:<8.4f}"
            f"{t7['band']:<14}{t7['calibrated_probability']:<8.4f}"
            f"{flag}"
        )

    print()
    print(f"disagreements: {disagreements} of {len(rows)}")
    print(f"T0 auto_release -> T7 reject cases: {len(release_then_reject)} {release_then_reject}")
    print()
    print(json.dumps({"disagreements": disagreements, "total": len(rows),
                      "release_then_reject": release_then_reject}, indent=2))


if __name__ == "__main__":
    main()
