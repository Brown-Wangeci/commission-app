"""NFR-02: measure the real scoring round trip, including the 90 days of
history the app actually sends, across a sample of the dataset.

Builds each request with src.serve.testing.build_request_payload -- the same
function tests/test_serve.py and scripts/smoke_test_service.py use to build a
request identical in shape to what the app sends (src/lib/scoring/payload.ts),
with the same HISTORY_DAYS=90 trailing window. Sends it over real HTTP to a
running instance of the service (not the in-process TestClient), one call at a
time, exactly as the app's synchronous submission path calls it -- this is a
single-submission latency measurement, not a concurrency test (that is
NFR-01's job, and the scoring service is explicitly excluded from NFR-01
because it is an external service).

A full pass over the dataset's ~90,000 activations, in both modes, at the
multi-second per-call cost measured here, would take many hours. This samples
N activations per mode, with a fixed seed for reproducibility, and reports
that honestly rather than claiming full-dataset coverage.

Usage:
  (start the service first: uvicorn src.serve.app:app --host 127.0.0.1 --port 8000)
  .venv/Scripts/python.exe scripts/measure_scoring_latency.py [N] [out_dir]
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import httpx  # noqa: E402

from src.generator import config as config_module  # noqa: E402
from src.serve import testing as serve_testing  # noqa: E402

TARGET_S = 1.0
SEED = 20261109
SERVICE_URL = "http://127.0.0.1:8000"


def percentile(sorted_values: list, p: float) -> float:
    if not sorted_values:
        return float("nan")
    index = min(len(sorted_values) - 1, int((p / 100) * len(sorted_values)))
    return sorted_values[index]


def summarise(samples: list) -> dict:
    ms = sorted(s["seconds"] for s in samples)
    within = sum(1 for s in ms if s <= TARGET_S)
    return {
        "n": len(ms),
        "mean_s": sum(ms) / len(ms) if ms else None,
        "p50_s": percentile(ms, 50),
        "p95_s": percentile(ms, 95),
        "p99_s": percentile(ms, 99),
        "max_s": ms[-1] if ms else None,
        "min_s": ms[0] if ms else None,
        "within_1s": within,
        "within_1s_share": within / len(ms) if ms else None,
        "errors": sum(1 for s in samples if s["status"] != 200),
    }


def main() -> None:
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 200
    out_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else REPO_ROOT / "docs" / "chapter5" / "evidence" / "performance"
    out_dir.mkdir(parents=True, exist_ok=True)

    gen_cfg = config_module.load_config(config_module.GENERATOR_CONFIG)
    history_days = int(gen_cfg["features"]["msisdn_history_days"])
    frames = serve_testing.load_frames()
    total = len(frames["activations"])
    ids = frames["activations"]["activation_id"].sample(n, random_state=SEED).tolist()

    print(f"Dataset has {total} activations; sampling {n} (seed {SEED}), timing both modes, sequentially, real HTTP.")
    all_samples = []
    by_mode = {"t0": [], "t7": []}
    started_run = time.perf_counter()
    with httpx.Client(timeout=30.0) as client:
        health = client.get(f"{SERVICE_URL}/health")
        print(f"GET /health -> {health.status_code} {health.json()}")
        for i, activation_id in enumerate(ids):
            for mode in ("t0", "t7"):
                payload = serve_testing.build_request_payload(activation_id, frames, history_days, mode=mode)
                started = time.perf_counter()
                response = client.post(f"{SERVICE_URL}/score", json=payload)
                elapsed = time.perf_counter() - started
                sample = {"activation_id": activation_id, "mode": mode, "seconds": elapsed, "status": response.status_code}
                all_samples.append(sample)
                by_mode[mode].append(sample)
            if (i + 1) % 20 == 0:
                print(f"  {i + 1}/{n} activations timed ({time.perf_counter() - started_run:.0f}s elapsed)")

    report = {
        "measured_at": "2026-11-09",
        "sample_size_per_mode": n,
        "dataset_total_activations": total,
        "sampling": f"uniform random sample, random_state={SEED}, not the full dataset (see script docstring for why)",
        "history_days_sent": history_days,
        "target_seconds": TARGET_S,
        "overall": summarise(all_samples),
        "by_mode": {mode: summarise(samples) for mode, samples in by_mode.items()},
    }
    print("\n" + json.dumps(report, indent=2))

    (out_dir / "nfr02-scoring-latency.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    import csv
    with open(out_dir / "nfr02-scoring-latency-samples.csv", "w", encoding="ascii", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["activation_id", "mode", "seconds", "status"])
        for s in all_samples:
            writer.writerow([s["activation_id"], s["mode"], f"{s['seconds']:.4f}", s["status"]])
    print(f"\nWrote {out_dir / 'nfr02-scoring-latency.json'} and nfr02-scoring-latency-samples.csv")


if __name__ == "__main__":
    main()
