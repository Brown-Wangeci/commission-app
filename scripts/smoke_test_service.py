"""E1: start the service, score twenty held-out activations spanning all
three bands, and print the responses.

Usage: .venv/Scripts/python.exe scripts/smoke_test_service.py

Runs the FastAPI app in-process via TestClient (no separate server process
needed), so this can run in CI without binding a port.
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
    artifact = artifact_module.load_artifact()
    dataset = data_module.load_dataset()
    calibration_index = serve_testing.held_out_calibration_index(dataset, model_cfg)
    activation_ids = serve_testing.select_smoke_test_ids(
        artifact, dataset, calibration_index, count=COUNT
    )
    print(f"scoring {len(activation_ids)} held-out activations "
          f"(unseen by the artifact's tree fit)\n")

    frames = serve_testing.load_frames()
    gen_cfg = config_module.load_config(config_module.GENERATOR_CONFIG)
    history_days = int(gen_cfg["features"]["msisdn_history_days"])

    band_counts = {"auto_release": 0, "review": 0, "reject": 0}
    with TestClient(app) as client:
        health = client.get("/health")
        print(f"GET /health -> {health.status_code} {health.json()}\n")

        for activation_id in activation_ids:
            payload = serve_testing.build_request_payload(activation_id, frames, history_days)
            response = client.post("/score", json=payload)
            if response.status_code != 200:
                print(f"{activation_id}: HTTP {response.status_code} {response.text}")
                continue
            body = response.json()
            band_counts[body["band"]] += 1
            reasons = "; ".join(
                f"{r['description']}"
                f"{' [agent history]' if r['is_agent_level'] else ''} ({r['direction']})"
                for r in body["top_reasons"]
            )
            print(
                f"{activation_id}  band={body['band']:<12} "
                f"p={body['calibrated_probability']:.4f}  raw={body['raw_score']:.4f}"
            )
            print(f"    reasons: {reasons}")

            explain = client.get(f"/explain/{activation_id}")
            assert explain.status_code == 200, f"explain lookup failed for {activation_id}"

    print(f"\nband counts: {json.dumps(band_counts)}")
    if all(count > 0 for count in band_counts.values()):
        print("all three bands represented")
    else:
        print("WARNING: not every band was represented in this sample")


if __name__ == "__main__":
    main()
