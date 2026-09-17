"""Single entry point: reproduce every dataset, model and results file.

Usage:
    python scripts/reproduce_all.py                      run every stage, in order
    python scripts/reproduce_all.py --stage generate      run just one stage
    python scripts/reproduce_all.py --stage train --stage multiseed
    python scripts/reproduce_all.py --seed 101             override the single-dataset seed
    python scripts/reproduce_all.py --tolerance 0.05      widen the reproduction check
    python scripts/reproduce_all.py --dry-run             print the plan, run nothing
    python scripts/reproduce_all.py --list-stages         list stage names and exit

Runs each `python -m <module>` step this project already has, in dependency
order, from a clean checkout: generate the dataset(s), train, calibrate,
evaluate, optimise decision bands, and produce every figure and results CSV.
No stage here does anything a human could not already do by running these
modules by hand in this order -- this script only sequences them and times
each one.

At the end it re-reads a fixed set of headline numbers (PR-AUC by model, both
models' band operating points, per-typology recall, the fairness table) as
they stood on disk before this run, compares them against what this run just
wrote, and fails loudly -- naming every number involved -- if any of them
moved by more than `--tolerance` (relative). Everything here is deterministic
given a fixed seed (config/generator.yaml `seed`, config/model.yaml
`cross_validation.cv_seed` and `multi_seed.seeds`); a full rerun should
reproduce the committed numbers up to floating-point noise from parallel
tree building, which is what the tolerance is for.

`--stage` selects a subset; stages always run in the dependency order below,
regardless of the order given on the command line. A stage's prerequisites
must already be on disk (either from an earlier full run, or from an earlier
invocation of this script) -- this script does not check that for you.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterator, List, Sequence

import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from src.generator import config as config_module  # noqa: E402

OUTPUT_DIR = REPO_ROOT / "outputs"
GENERATOR_CONFIG = REPO_ROOT / "config" / "generator.yaml"
MANIFEST_PATH = OUTPUT_DIR / "reproduce_manifest.json"

# Dependency order. Each module is a plain `python -m <module>` step; see the
# module's own docstring for what it reads and writes. Grouped the way the
# phases that produced them were: generate (the single seed-42 dataset),
# diagnostics (self-contained, multi-seed, no dependency on data/ on disk),
# train (Phase 3/4, needs data/ from `generate`), multiseed (Phase 5, the
# four-seed run), calibrate (needs multiseed), bands (Phase 6 + Phase 8's T0
# bands + everything downstream of a calibrated, banded model), figures
# (needs almost everything above).
STAGES: Dict[str, List[str]] = {
    "generate": ["src.generator.run"],
    "diagnostics": [
        "src.eval.report",
        "src.eval.seeds",
        "src.eval.realisation_control",
        "src.eval.lookalike_audit",
    ],
    "train": [
        "src.train.run",
        "src.train.resampling_sweep",
        "src.eval.collusion_check",
        "src.eval.agent_vs_activation",
        "src.eval.investigations",
        "src.eval.before_after",
    ],
    "multiseed": ["src.train.multiseed"],
    "calibrate": ["src.eval.calibration"],
    "bands": [
        "src.eval.costs",
        "src.eval.bands",
        "src.serve.bands_t0",
        "src.eval.fairness",
        "src.eval.band_comparison",
        "src.eval.auto_release",
        "src.eval.multiseed_results",
        "src.eval.commission_sweep",
        "src.eval.explanations",
        "src.eval.disagreement",
    ],
    "figures": ["src.eval.figures"],
}

# label, path, key columns, value columns to check for B3's headline report.
HeadlineTable = tuple
HEADLINE_TABLES: List[HeadlineTable] = [
    ("PR-AUC by model", OUTPUT_DIR / "multiseed_results_summary.csv",
     ["model"], ["pr_auc_mean"]),
    ("T7 band operating point", OUTPUT_DIR / "band_operating_point.csv",
     ["variant"], ["release_threshold", "reject_threshold", "expected_cost_per_activation"]),
    ("T0 band operating point", OUTPUT_DIR / "band_operating_point_t0.csv",
     ["variant"], ["release_threshold", "reject_threshold", "expected_cost_per_activation"]),
    ("Per-typology recall (single-seed CV)", OUTPUT_DIR / "typology_recall_summary.csv",
     ["model", "precision_target", "typology"], ["recall_mean"]),
    ("Fairness by honesty", OUTPUT_DIR / "fairness_bands_by_honesty.csv",
     ["honesty_type", "band"], ["share_mean"]),
]


@dataclass
class StepResult:
    module: str
    seconds: float
    returncode: int


def run_module(module: str) -> StepResult:
    started = time.perf_counter()
    result = subprocess.run([sys.executable, "-m", module], cwd=REPO_ROOT)
    return StepResult(module=module, seconds=time.perf_counter() - started, returncode=result.returncode)


@contextmanager
def overridden_seed(seed: int | None) -> Iterator[None]:
    """Temporarily set config/generator.yaml's top-level seed, then restore it.

    Written to the file rather than passed in memory, so every stage --
    including ones run as a separate `python -m` subprocess -- reads the same
    seed, and the manifest each stage writes records the config hash that
    actually produced the data on disk.
    """
    if seed is None:
        yield
        return
    original = GENERATOR_CONFIG.read_text(encoding="utf-8")
    pattern = re.compile(r"^seed:\s*\d+", re.MULTILINE)
    if not pattern.search(original):
        raise ValueError(f"could not find a top-level 'seed:' line in {GENERATOR_CONFIG}")
    GENERATOR_CONFIG.write_text(pattern.sub(f"seed: {seed}", original, count=1), encoding="utf-8")
    try:
        yield
    finally:
        GENERATOR_CONFIG.write_text(original, encoding="utf-8")


def snapshot_headline_tables() -> Dict[str, pd.DataFrame | None]:
    return {
        str(path): (pd.read_csv(path) if path.exists() else None)
        for _, path, _, _ in HEADLINE_TABLES
    }


def compare_headline_tables(
    before: Dict[str, pd.DataFrame | None], tolerance: float
) -> tuple[pd.DataFrame, bool]:
    rows = []
    all_ok = True
    for label, path, keys, values in HEADLINE_TABLES:
        prior = before[str(path)]
        current = pd.read_csv(path) if path.exists() else None
        if prior is None or current is None:
            rows.append({"table": label, "row": "(file missing before or after this run)",
                         "column": "", "before": None, "after": None, "status": "SKIPPED"})
            continue
        merged = prior.merge(current, on=keys, suffixes=("_before", "_after"), how="outer")
        for value in values:
            for _, record in merged.iterrows():
                row_id = ", ".join(f"{k}={record[k]}" for k in keys)
                before_value = record.get(f"{value}_before")
                after_value = record.get(f"{value}_after")
                if pd.isna(before_value) or pd.isna(after_value):
                    status = "MISSING"
                else:
                    diff = abs(float(after_value) - float(before_value))
                    denominator = abs(float(before_value))
                    relative = diff / denominator if denominator > 1e-12 else diff
                    status = "OK" if relative <= tolerance else "FAIL"
                if status != "OK":
                    all_ok = False
                rows.append({
                    "table": label, "row": row_id, "column": value,
                    "before": before_value, "after": after_value, "status": status,
                })
    return pd.DataFrame(rows), all_ok


def plan(stage_names: Sequence[str]) -> List[str]:
    ordered = [name for name in STAGES if name in stage_names]
    modules = []
    for name in ordered:
        modules.extend(STAGES[name])
    return modules


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--stage", action="append", choices=list(STAGES), default=None,
                         help="run only this stage (repeatable); default: all stages")
    parser.add_argument("--seed", type=int, default=None,
                         help="override config/generator.yaml's seed for this run only")
    parser.add_argument("--tolerance", type=float, default=0.02,
                         help="relative tolerance for the headline-number reproduction check (default 0.02)")
    parser.add_argument("--dry-run", action="store_true", help="print the planned steps and exit")
    parser.add_argument("--list-stages", action="store_true", help="list stage names and exit")
    args = parser.parse_args()

    if args.list_stages:
        for name, modules in STAGES.items():
            print(f"{name}: {', '.join(modules)}")
        return

    requested = set(args.stage) if args.stage else set(STAGES)
    stage_names = [name for name in STAGES if name in requested]  # canonical order, not CLI order
    modules = plan(stage_names)

    if args.dry_run:
        print(f"stages: {', '.join(stage_names)}")
        for module in modules:
            print(f"  python -m {module}")
        if args.seed is not None:
            print(f"seed override: {args.seed}")
        return

    before = snapshot_headline_tables()
    steps: List[StepResult] = []
    stage_seconds: Dict[str, float] = {}
    started_all = time.perf_counter()

    with overridden_seed(args.seed):
        for stage_name in stage_names:
            stage_started = time.perf_counter()
            for module in STAGES[stage_name]:
                print(f"\n=== {stage_name}: python -m {module} ===", flush=True)
                result = run_module(module)
                steps.append(result)
                print(f"--- {module} finished in {result.seconds:.1f}s "
                      f"(exit {result.returncode}) ---", flush=True)
                if result.returncode != 0:
                    print(f"\nFAILED at {module} (stage {stage_name!r}); stopping.", file=sys.stderr)
                    _write_manifest(steps, stage_seconds, started_all, args, ok=False, comparison=None)
                    sys.exit(result.returncode)
            stage_seconds[stage_name] = time.perf_counter() - stage_started

    comparison, ok = compare_headline_tables(before, args.tolerance)
    total_seconds = time.perf_counter() - started_all

    print("\n=== stage timings ===")
    for name, seconds in stage_seconds.items():
        print(f"{name:<12} {seconds:>8.1f}s")
    print(f"{'total':<12} {total_seconds:>8.1f}s")

    print("\n=== headline numbers vs. what was on disk before this run "
          f"(tolerance {args.tolerance:.1%} relative) ===")
    pd.set_option("display.width", 200)
    print(comparison.to_string(index=False))

    _write_manifest(steps, stage_seconds, started_all, args, ok=ok, comparison=comparison)

    if not ok:
        failed = comparison[comparison["status"] == "FAIL"]
        print(f"\nFAILED: {len(failed)} headline number(s) moved by more than "
              f"{args.tolerance:.1%}:", file=sys.stderr)
        print(failed.to_string(index=False), file=sys.stderr)
        sys.exit(1)

    print("\nAll headline numbers reproduced within tolerance.")


def _write_manifest(
    steps: List[StepResult],
    stage_seconds: Dict[str, float],
    started_all: float,
    args: argparse.Namespace,
    ok: bool | None,
    comparison: pd.DataFrame | None,
) -> None:
    import json
    from datetime import datetime, timezone

    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "stages_requested": args.stage or list(STAGES),
        "seed_override": args.seed,
        "tolerance": args.tolerance,
        "total_seconds": round(time.perf_counter() - started_all, 1),
        "stage_seconds": {k: round(v, 1) for k, v in stage_seconds.items()},
        "steps": [{"module": s.module, "seconds": round(s.seconds, 1), "returncode": s.returncode} for s in steps],
        "reproduced_within_tolerance": ok,
        "headline_comparison": comparison.to_dict(orient="records") if comparison is not None else None,
        "config_hash": config_module.config_hash(
            [config_module.GENERATOR_CONFIG, config_module.MODEL_CONFIG]
        ),
    }
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
