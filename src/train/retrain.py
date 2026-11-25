"""Retrain with the labels reviewers leave behind, and compare (DR-10).

Usage: python -m src.train.retrain [--seeds 7,42] [--folds 1] [--export <dir>]

Two arms, trained on the same folds with the same hyperparameters, so the only
difference between them is the extra rows:

  baseline   the committed procedure: the synthetic training split alone
  candidate  the same split plus every exported review label, weighted

Both are fitted on the fold's fit rows, calibrated on the fold's calibration
agents (synthetic, so the two calibrators are comparable), and scored on the
fold's test rows. A review label is a real submission a person decided; it
joins a training split and never a test split, so no arm is ever scored on a
row it trained on. Both arms are also scored on the review labels themselves,
which is out of sample for the baseline and IN SAMPLE for the candidate; the
report says so beside the number.

The hyperparameter search runs once per fold, on the baseline's inner split,
and both arms use its result. Searching separately would let search noise,
rather than the labels, move the comparison.

THIS MODULE PROMOTES NOTHING. It writes CSVs and a report under outputs/ and
touches neither artifacts/ nor config/serving.yaml. Publishing a new artifact
is a manual step, written up in docs/RETRAINING.md.
"""

from __future__ import annotations

import argparse
import copy
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression

from ..eval.cv import Fold, build_folds, derived_seed
from ..eval.metrics import fold_metrics, precision_key
from ..generator import config as config_module
from ..generator.run import generate
from . import review_labels as review_module
from .data import FEATURE_SETS
from .models import fit_xgboost
from .search import sample_candidates, search_xgboost

OUTPUT_DIR = config_module.REPO_ROOT / "outputs"
FOLD_PATH = OUTPUT_DIR / "retraining_fold_comparison.csv"
SUMMARY_PATH = OUTPUT_DIR / "retraining_summary.csv"
REPORT_PATH = OUTPUT_DIR / "retraining_report.md"

ARMS = ("baseline", "candidate")
CALIBRATION = "isotonic"


@dataclass(frozen=True)
class Plan:
    """Everything the comparison was asked to do, before it does any of it."""

    model_name: str
    feature_set: str
    method: str
    seeds: List[int]
    max_folds: int | None
    review_weight: float
    min_labels: int


def build_plan(
    model_cfg: Dict[str, Any], retrain_cfg: Dict[str, Any], seeds: List[int] | None, max_folds: int | None
) -> Plan:
    cfg = retrain_cfg["retraining"]
    name = str(cfg["model"])
    spec = next(entry for entry in model_cfg["multi_seed"]["models"] if entry["name"] == name)
    return Plan(
        model_name=name,
        feature_set=str(spec["feature_set"]),
        method=str(spec["method"]),
        seeds=[int(seed) for seed in (seeds if seeds is not None else cfg["seeds"])],
        max_folds=max_folds,
        review_weight=float(cfg["review_label_weight"]),
        min_labels=int(cfg["min_labels_for_promotion"]),
    )


def dataset_for_seed(gen_cfg: Dict[str, Any], seed: int) -> Dict[str, Any]:
    """One seed's generated dataset, built exactly as src.train.multiseed builds it."""
    seeded = copy.deepcopy(gen_cfg)
    seeded["seed"] = seed
    _, internal, features, _ = generate(write=False, cfg=seeded)
    aligned = internal.labels.set_index("activation_id").reindex(features.keys["activation_id"])
    return {
        "config": seeded,
        "keys": features.keys,
        "features": pd.concat([features.t0, features.t7], axis=1),
        "labels": aligned["is_fraudulent"].to_numpy().astype(int),
    }


def _calibrated(model: Any, fit_matrix: pd.DataFrame, calibration: tuple, test_matrix: pd.DataFrame) -> np.ndarray:
    """Fit the isotonic calibrator on held-out agents and apply it to the test rows."""
    calibration_matrix, calibration_labels = calibration
    calibrator = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
    calibrator.fit(model.predict_proba(calibration_matrix)[:, 1], calibration_labels)
    return np.asarray(calibrator.predict(model.predict_proba(test_matrix)[:, 1]), dtype=float)


def _review_metrics(labels: np.ndarray, scores: np.ndarray, targets: List[float]) -> Dict[str, float]:
    """Metrics on the review labels, or NaN where one class is missing, which it is while there are few."""
    if len(labels) == 0 or len(np.unique(labels)) < 2:
        return {"review_pr_auc": float("nan"), "review_roc_auc": float("nan"), "review_mean_score": float(np.mean(scores)) if len(scores) else float("nan")}
    measured = fold_metrics(labels, scores, targets)
    return {"review_pr_auc": measured["pr_auc"], "review_roc_auc": measured["roc_auc"], "review_mean_score": float(np.mean(scores))}


def compare_fold(
    dataset: Dict[str, Any],
    fold: Fold,
    plan: Plan,
    model_cfg: Dict[str, Any],
    seed: int,
    review_matrix: pd.DataFrame,
    review_labels: np.ndarray,
) -> List[Dict[str, Any]]:
    """Train both arms on one fold and score them on the same rows."""
    xgb_cfg = model_cfg["xgboost"]
    targets = [float(t) for t in model_cfg["reporting"]["precision_targets"]]
    features = list(FEATURE_SETS[plan.feature_set])
    matrix = dataset["features"][features]
    labels = dataset["labels"]
    cv_seed = int(model_cfg["cross_validation"]["cv_seed"])
    fold_seed = derived_seed(cv_seed, seed, fold.fold)

    rng = np.random.default_rng(derived_seed(cv_seed, seed, fold.fold, 1))
    candidates = sample_candidates(xgb_cfg["search_space"], int(xgb_cfg["search_iterations"]), rng)
    search = search_xgboost(
        (matrix.iloc[fold.inner_train_index], labels[fold.inner_train_index]),
        (matrix.iloc[fold.inner_val_index], labels[fold.inner_val_index]),
        candidates, plan.method, model_cfg, fold_seed,
    )

    fit_rows = fold.model_fit_rows()
    fit_matrix = matrix.iloc[fit_rows]
    fit_labels = labels[fit_rows]
    calibration = (matrix.iloc[fold.calibration_index], labels[fold.calibration_index])
    test_matrix = matrix.iloc[fold.test_index]
    test_labels = labels[fold.test_index]

    arms = {
        "baseline": (fit_matrix, fit_labels, np.ones(len(fit_rows))),
        "candidate": (
            pd.concat([fit_matrix, review_matrix], ignore_index=True),
            np.concatenate([fit_labels, review_labels]),
            np.concatenate([np.ones(len(fit_rows)), np.full(len(review_labels), plan.review_weight)]),
        ),
    }

    records: List[Dict[str, Any]] = []
    for arm, (arm_matrix, arm_labels, weights) in arms.items():
        model = fit_xgboost(
            arm_matrix, arm_labels, search.best, plan.method, model_cfg, fold_seed, sample_weight=weights
        )
        scores = _calibrated(model, arm_matrix, calibration, test_matrix)
        review_scores = (
            np.asarray(model.predict_proba(review_matrix)[:, 1], dtype=float) if len(review_labels) else np.array([])
        )
        records.append({
            "seed": seed,
            "fold": fold.fold,
            "model": plan.model_name,
            "arm": arm,
            "n_fit_synthetic": int(len(fit_rows)),
            "n_fit_review": int(len(review_labels)) if arm == "candidate" else 0,
            "review_weight_share": float(
                plan.review_weight * len(review_labels) / (plan.review_weight * len(review_labels) + len(fit_rows))
            ) if arm == "candidate" else 0.0,
            "inner_val_pr_auc": float(search.best_inner_pr_auc),
            **fold_metrics(test_labels, scores, targets),
            **_review_metrics(review_labels, review_scores, targets),
        })
    return records


def metric_columns(model_cfg: Dict[str, Any]) -> List[str]:
    targets = [float(t) for t in model_cfg["reporting"]["precision_targets"]]
    return ["pr_auc", "roc_auc", *[precision_key(target) for target in targets], "review_pr_auc", "review_mean_score"]


def summarise(folds: pd.DataFrame, model_cfg: Dict[str, Any]) -> pd.DataFrame:
    """Mean across seeds with the seed-level spread, and the fold spread beside it.

    The seed-level spread is the headline uncertainty. Fold-to-fold variation
    understates it, because StratifiedGroupKFold orders groups by size, so
    fold 0 always carries the heaviest agents and the folds are not
    exchangeable (CLAUDE.md, config/model.yaml multi_seed).
    """
    rows = []
    for arm in ARMS:
        arm_folds = folds[folds["arm"] == arm]
        per_seed = arm_folds.groupby("seed")[metric_columns(model_cfg)].mean()
        for metric in metric_columns(model_cfg):
            rows.append({
                "arm": arm,
                "metric": metric,
                "mean_across_seeds": float(per_seed[metric].mean()),
                "sd_across_seeds": float(per_seed[metric].std(ddof=1)) if len(per_seed) > 1 else float("nan"),
                "n_seeds": int(len(per_seed)),
                "mean_fold_sd": float(arm_folds.groupby("seed")[metric].std(ddof=1).mean()) if len(arm_folds) > len(per_seed) else float("nan"),
            })
    return pd.DataFrame(rows)


def differences(summary: pd.DataFrame) -> pd.DataFrame:
    """Candidate minus baseline, per metric, on the seed means."""
    wide = summary.pivot(index="metric", columns="arm", values="mean_across_seeds")
    spread = summary.pivot(index="metric", columns="arm", values="sd_across_seeds")
    return pd.DataFrame({
        "metric": wide.index,
        "baseline": wide["baseline"].to_numpy(),
        "candidate": wide["candidate"].to_numpy(),
        "difference": (wide["candidate"] - wide["baseline"]).to_numpy(),
        "baseline_sd_across_seeds": spread["baseline"].to_numpy(),
    }).reset_index(drop=True)


def band_agreement(review: review_module.ReviewLabels) -> pd.DataFrame:
    """How the deployed model's own band compared with the reviewer's decision.

    Straight from the export: these are the stored decisions the reviewers saw,
    so this is the one genuinely out-of-sample comparison on real submissions.
    """
    if len(review) == 0:
        return pd.DataFrame(columns=["band", "decision", "rows"])
    counts = review.frame.groupby(["model_band", "decision"]).size().reset_index(name="rows")
    return counts.rename(columns={"model_band": "band"})


def run(
    gen_cfg: Dict[str, Any], model_cfg: Dict[str, Any], plan: Plan, review: review_module.ReviewLabels
) -> pd.DataFrame:
    """Every fold of every seed, both arms."""
    usable = review.for_feature_set(plan.feature_set, tuple(FEATURE_SETS[plan.feature_set]))
    review_matrix = (
        usable.matrix(tuple(FEATURE_SETS[plan.feature_set]))
        if len(usable)
        else pd.DataFrame(columns=list(FEATURE_SETS[plan.feature_set]), dtype=float)
    )
    review_labels = usable.labels
    records: List[Dict[str, Any]] = []
    for seed in plan.seeds:
        dataset = dataset_for_seed(gen_cfg, seed)
        single = copy.deepcopy(model_cfg)
        single["cross_validation"]["n_repeats"] = int(model_cfg["multi_seed"]["n_repeats"])
        folds = build_folds(dataset["keys"], dataset["labels"], dataset["config"], single, with_calibration=True)
        if plan.max_folds is not None:
            folds = folds[: plan.max_folds]
        for fold in folds:
            records.extend(compare_fold(dataset, fold, plan, model_cfg, seed, review_matrix, review_labels))
            print(f"seed {seed} fold {fold.fold} done")
    return pd.DataFrame(records)


def _fmt(value: float, places: int = 4) -> str:
    return "n/a" if value is None or (isinstance(value, float) and np.isnan(value)) else f"{value:.{places}f}"


def report(
    plan: Plan, review: review_module.ReviewLabels, folds: pd.DataFrame, summary: pd.DataFrame, model_cfg: Dict[str, Any]
) -> str:
    """The comparison report. States what was run, on how many labels, and that nothing was promoted."""
    usable = review.for_feature_set(plan.feature_set, tuple(FEATURE_SETS[plan.feature_set]))
    diff = differences(summary)
    enough = len(usable) >= plan.min_labels
    share = float(folds[folds["arm"] == "candidate"]["review_weight_share"].mean()) if len(folds) else 0.0
    lines = [
        f"# Retraining comparison: {plan.model_name}",
        "",
        f"Run {datetime.now(timezone.utc).isoformat(timespec='seconds')} by `python -m src.train.retrain`.",
        "",
        "## Verdict",
        "",
        (
            f"**Not enough labels to support any promotion decision.** The export holds "
            f"{len(usable)} usable label(s); `retraining.min_labels_for_promotion` is {plan.min_labels}. "
            "The numbers below are reported because they were measured, not because they mean anything: "
            "a difference computed from this many labels is noise."
            if not enough
            else f"{len(usable)} usable label(s), at or above the configured minimum of {plan.min_labels}. "
            "Read the differences against the seed-level spread before proposing a promotion."
        ),
        "",
        "**Nothing was promoted.** This run wrote no artifact and changed no configuration. "
        "Publishing a model is a separate manual step: see `docs/RETRAINING.md`.",
        "",
        "## The labels",
        "",
        f"- Export `{review.version}`, taken {review.manifest.get('exportedAt')}.",
        f"- {review.manifest.get('rows')} reviewed submission(s) in the export; {len(usable)} scored with the "
        f"`{plan.feature_set}` feature set, which is what this model can learn from.",
        f"- By decision: {json.dumps(review.manifest.get('labels'))}; by mode: {json.dumps(review.manifest.get('byMode'))}.",
        f"- Decision dates: {review.manifest.get('decisionRange', {}).get('first')} to {review.manifest.get('decisionRange', {}).get('last')}.",
        f"- Skipped by the export: {json.dumps(review.manifest.get('skipped'))}.",
        "",
        "## Weighting",
        "",
        f"Each review row carries weight {plan.review_weight} against 1.0 for a synthetic row "
        f"(`retraining.review_label_weight`). On these folds that is {share * 100:.4f}% of the "
        "training weight. Equal weight is deliberate: review labels exist only for the bands that reach "
        "a person, so upweighting them would amplify that selection bias rather than correct it.",
        "",
        "## Candidate against baseline",
        "",
        f"Mean across {sorted(folds['seed'].unique().tolist()) if len(folds) else []} "
        f"({summary['n_seeds'].max() if len(summary) else 0} seed(s)), out of fold, isotonic-calibrated.",
        "",
        "| Metric | Baseline | Candidate | Difference | Baseline sd across seeds |",
        "|---|---|---|---|---|",
    ]
    for _, row in diff.iterrows():
        lines.append(
            f"| {row['metric']} | {_fmt(row['baseline'])} | {_fmt(row['candidate'])} | "
            f"{_fmt(row['difference'])} | {_fmt(row['baseline_sd_across_seeds'])} |"
        )
    lines += [
        "",
        "The spread is across seeds, which is the headline uncertainty. Fold-to-fold variation is secondary "
        "and understates it: `StratifiedGroupKFold` orders groups by size, so fold 0 always carries the "
        "heaviest agents and the folds are not exchangeable.",
        "",
        "`review_pr_auc` and `review_mean_score` are measured on the review labels themselves. For the "
        "baseline that is out of sample; **for the candidate it is in sample**, because those rows are in "
        "its training split. They are not a basis for choosing between the arms. `n/a` means one class was "
        "missing, which it is while there are this few labels.",
        "",
        "## The deployed model against the reviewers, on the same submissions",
        "",
        "Taken straight from the stored decisions, so no model was refitted here.",
        "",
    ]
    agreement = band_agreement(usable)
    if len(agreement) == 0:
        lines.append("No usable labels, so there is nothing to compare.")
    else:
        lines += ["| Model band | Reviewer decided | Submissions |", "|---|---|---|"]
        for _, row in agreement.iterrows():
            lines.append(f"| {row['band']} | {row['decision']} | {int(row['rows'])} |")
    lines += [
        "",
        "## Provenance",
        "",
        f"- generator config hash `{config_module.config_hash([config_module.GENERATOR_CONFIG])}`",
        f"- model config hash `{config_module.config_hash([config_module.MODEL_CONFIG])}`",
        f"- retraining config hash `{config_module.config_hash([config_module.RETRAINING_CONFIG])}`",
        f"- labels sha256 `{review.manifest.get('sha256')}`",
        f"- cv seed {model_cfg['cross_validation']['cv_seed']}, seeds {plan.seeds}, "
        f"folds per seed {'all' if plan.max_folds is None else plan.max_folds}",
        "",
    ]
    return "\n".join(lines)


def parse_args(argv: List[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compare a review-label candidate against the committed procedure.")
    parser.add_argument("--seeds", help="comma-separated seeds; defaults to retraining.seeds")
    parser.add_argument("--folds", type=int, help="use only the first N folds of each seed")
    parser.add_argument("--export", help="path to one export folder; defaults to the newest under retraining.export_dir")
    parser.add_argument("--out", help="directory for the CSVs and the report; defaults to outputs/")
    return parser.parse_args(argv)


def main(argv: List[str] | None = None) -> None:
    args = parse_args(argv)
    gen_cfg = config_module.load_config(config_module.GENERATOR_CONFIG)
    model_cfg = config_module.load_config(config_module.MODEL_CONFIG)
    retrain_cfg = config_module.load_config(config_module.RETRAINING_CONFIG)
    seeds = [int(seed) for seed in args.seeds.split(",")] if args.seeds else None
    plan = build_plan(model_cfg, retrain_cfg, seeds, args.folds)
    export = Path(args.export) if args.export else review_module.latest_export(review_module.export_root(retrain_cfg))
    review = review_module.load_export(export)
    print(f"export {review.version}: {len(review)} row(s); model {plan.model_name}; seeds {plan.seeds}")

    folds = run(gen_cfg, model_cfg, plan, review)
    summary = summarise(folds, model_cfg)
    out = Path(args.out) if args.out else OUTPUT_DIR
    out.mkdir(parents=True, exist_ok=True)
    folds.to_csv(out / FOLD_PATH.name, index=False)
    summary.to_csv(out / SUMMARY_PATH.name, index=False)
    (out / REPORT_PATH.name).write_text(report(plan, review, folds, summary, model_cfg), encoding="utf-8")
    print(f"wrote {out / FOLD_PATH.name}, {out / SUMMARY_PATH.name}, {out / REPORT_PATH.name}")
    print("nothing was promoted: publishing an artifact is a manual step (docs/RETRAINING.md)")


if __name__ == "__main__":
    main()
