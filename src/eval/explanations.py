"""What the model tells an admin, and whether it is about the activation.

Usage: python -m src.eval.explanations

SHAP values are computed during training (src/train/multiseed) for the chosen
model, so the explanation always belongs to the model that produced the score.
This module aggregates them: globally, per fraud typology, and into the reason
strings an admin would actually read on a review screen.

The Phase 4 ablation found that removing agent-history features cost 0.111
PR-AUC. E4 asks the matching question of the explanations: when an admin opens a
flagged activation, are they being told about the activation or about the agent?
"""

from __future__ import annotations

from typing import Any, Dict, List

import numpy as np
import pandas as pd

from ..generator import config as config_module
from ..train.data import AGENT_HISTORY_FEATURES
from .calibration import load_predictions

OUTPUT_DIR = config_module.REPO_ROOT / "outputs"
SHAP_PATH = OUTPUT_DIR / "multiseed_shap.parquet"
SECONDS_PER_HOUR = 3600.0

# Plain language for a review screen. {v} is the feature's value on the row.
PHRASES: Dict[str, str] = {
    "agent_activation_velocity_24h": "the agent submitted {v:.0f} activations in the previous 24 hours",
    "agent_activation_velocity_1h": "the agent submitted {v:.0f} activations within the hour",
    "customer_active_days_7d": "the customer used the service on {v:.0f} of the 8 days after signup",
    "days_to_first_customer_activity": "the customer first used the service {v:.0f} days after signup",
    "transaction_count_7d": "the customer made {v:.0f} transactions in the first week",
    "topup_amount_total_7d": "the customer topped up {v:.0f} shillings in the first week",
    "usage_minutes_total_7d": "the customer used {v:.0f} minutes of service in the first week",
    "support_contact_count_7d": "the customer contacted support on {v:.0f} days",
    "complaint_or_refund_flag_7d": "a complaint or refund was filed in the first week",
    "sim_active_at_day7": "the account was still active a week later",
    "activity_dropoff_flag": "the customer used the service at first and then stopped",
    "device_shared_agent_count_30d": "{v:.0f} different agents used this device in the last 30 days",
    "device_activations_7d": "this device was used for {v:.0f} activations in the last 7 days",
    "distinct_devices_used_30d": "the agent used {v:.0f} different devices in the last 30 days",
    "customer_msisdn_prior_activation_count": "this phone number was activated {v:.0f} times before",
    "sim_age_at_activation_days": "the SIM was registered {v:.1f} days before the activation",
    "agent_tenure_days": "the agent has been on the platform {v:.0f} days",
    "distance_from_agent_home_km": "the activation was {v:.1f} km from the agent's base",
    "days_to_payout_cutoff": "the activation was submitted {v:.1f} days before a payout cutoff",
    "submission_hour_of_day": "the activation was submitted at {v:.0f}:00",
    "job_acceptance_latency_hours": "the job sat unaccepted for {v:.1f} hours",
    "submission_latency_hours": "{v:.1f} hours passed between the job being assigned and submitted",
    "acceptance_to_submission_hours": "the agent took {v:.1f} hours between accepting the job and submitting it",
    "ip_location_mismatch_flag": "the network location disagreed with the GPS location",
    "activation_method_is_manual_entry": "the details were keyed in by hand rather than scanned",
    "proof_of_activation_missing_flag": "no proof of activation was attached",
    "network_type_is_cellular": "the activation was submitted over mobile data rather than wifi",
}
SECONDS_FEATURES = {
    "job_acceptance_latency_seconds": "job_acceptance_latency_hours",
    "submission_latency_seconds": "submission_latency_hours",
    "acceptance_to_submission_seconds": "acceptance_to_submission_hours",
}


def load_shap() -> tuple[pd.DataFrame, List[str]]:
    frame = pd.read_parquet(SHAP_PATH)
    features = [c[len("shap_"):] for c in frame.columns if c.startswith("shap_")]
    return frame, features


def global_importance(frame: pd.DataFrame, features: List[str]) -> pd.DataFrame:
    """Mean absolute SHAP per feature, per seed, then averaged across seeds."""
    per_seed = frame.groupby("seed")[[f"shap_{name}" for name in features]].apply(
        lambda block: block.abs().mean()
    )
    summary = pd.DataFrame({
        "feature": features,
        "mean_abs_shap": [per_seed[f"shap_{name}"].mean() for name in features],
        "sd_across_seeds": [per_seed[f"shap_{name}"].std(ddof=1) for name in features],
    })
    summary["group"] = np.where(
        summary["feature"].isin(AGENT_HISTORY_FEATURES), "agent history", "activation or customer"
    )
    summary["share_of_total"] = summary["mean_abs_shap"] / summary["mean_abs_shap"].sum()
    return summary.sort_values("mean_abs_shap", ascending=False).reset_index(drop=True)


def importance_by_typology(
    frame: pd.DataFrame, features: List[str], context: pd.DataFrame
) -> pd.DataFrame:
    merged = frame.merge(context[["seed", "activation_id", "typology"]], on=["seed", "activation_id"])
    fraud = merged[merged["typology"] != "none"]
    rows = []
    for typology, group in fraud.groupby("typology"):
        for name in features:
            rows.append({
                "typology": typology, "feature": name,
                "mean_abs_shap": float(group[f"shap_{name}"].abs().mean()),
                "mean_signed_shap": float(group[f"shap_{name}"].mean()),
                "rows": int(len(group)),
            })
    table = pd.DataFrame(rows)
    table["share_within_typology"] = table.groupby("typology")["mean_abs_shap"].transform(
        lambda values: values / values.sum()
    )
    return table.sort_values(["typology", "mean_abs_shap"], ascending=[True, False]).reset_index(drop=True)


def agent_history_share(importance: pd.DataFrame, by_typology: pd.DataFrame) -> pd.DataFrame:
    rows = [{
        "scope": "all sampled rows",
        "agent_history_share_of_explanation": float(
            importance.loc[importance["group"] == "agent history", "mean_abs_shap"].sum()
            / importance["mean_abs_shap"].sum()
        ),
        "top_feature": importance.iloc[0]["feature"],
        "top_feature_is_agent_history": bool(importance.iloc[0]["group"] == "agent history"),
    }]
    for typology, group in by_typology.groupby("typology"):
        agent_rows = group[group["feature"].isin(AGENT_HISTORY_FEATURES)]
        rows.append({
            "scope": f"fraud: {typology}",
            "agent_history_share_of_explanation": float(
                agent_rows["mean_abs_shap"].sum() / group["mean_abs_shap"].sum()
            ),
            "top_feature": group.iloc[0]["feature"],
            "top_feature_is_agent_history": bool(group.iloc[0]["feature"] in AGENT_HISTORY_FEATURES),
        })
    return pd.DataFrame(rows)


def _readable(feature: str, value: float) -> str:
    name, shown = feature, value
    if feature in SECONDS_FEATURES:
        name, shown = SECONDS_FEATURES[feature], value / SECONDS_PER_HOUR
    template = PHRASES.get(name)
    if template is None:
        return f"{name} = {value:g}"
    if name.endswith("_flag") or name.startswith("activation_method") or name.startswith("network_type"):
        positive = template
        negative = {
            "complaint_or_refund_flag_7d": "no complaint or refund was filed",
            "sim_active_at_day7": "the account was closed within the week",
            "activity_dropoff_flag": "the customer did not show an early-then-stop pattern",
            "ip_location_mismatch_flag": "the network and GPS locations agreed",
            "activation_method_is_manual_entry": "the details were scanned rather than keyed in",
            "proof_of_activation_missing_flag": "proof of activation was attached",
            "network_type_is_cellular": "the activation was submitted over wifi",
        }.get(name, f"{name} was not set")
        return positive if shown >= 0.5 else negative
    return template.format(v=shown)


def worked_cases(
    frame: pd.DataFrame,
    features: List[str],
    scored: pd.DataFrame,
    context: pd.DataFrame,
    bands: Dict[str, float],
    top_features: int,
) -> pd.DataFrame:
    """One activation from each band, with the reason an admin would read."""
    merged = frame.merge(scored, on=["seed", "activation_id"]).merge(
        context[["seed", "activation_id", "typology", "honesty_type"]], on=["seed", "activation_id"]
    )
    # Same band convention as the cost surface: released at or below the release
    # threshold, rejected strictly above the reject threshold. Each case is the
    # median-scoring activation of its band, so it is what an admin typically
    # sees rather than the most extreme row.
    bands_of = {
        "auto-released": merged[merged["probability"] <= bands["release"]],
        "sent to review": merged[
            (merged["probability"] > bands["release"]) & (merged["probability"] <= bands["reject"])
        ],
        "rejected": merged[merged["probability"] > bands["reject"]],
    }
    rows = []
    for band, members in bands_of.items():
        if members.empty:
            continue
        ordered = members.sort_values("probability").reset_index(drop=True)
        case = ordered.iloc[len(ordered) // 2]
        contributions = pd.Series(
            {name: case[f"shap_{name}"] for name in features}
        ).sort_values(key=np.abs, ascending=False)
        reasons = []
        for name in contributions.index[:top_features]:
            direction = "raises" if contributions[name] > 0 else "lowers"
            reasons.append(f"{_readable(name, case[f'value_{name}'])} ({direction} the score)")
        rows.append({
            "band": band,
            "seed": int(case["seed"]),
            "activation_id": case["activation_id"],
            "calibrated_probability": float(case["probability"]),
            "actually_fraudulent": bool(case["label"]),
            "typology": case["typology"],
            "agent_honesty_type": case["honesty_type"],
            "reason_shown_to_admin": "; ".join(reasons),
        })
    return pd.DataFrame(rows)


def main() -> None:
    model_cfg = config_module.load_config(config_module.MODEL_CONFIG)
    method = str(pd.read_csv(OUTPUT_DIR / "calibration_choice.csv")["chosen_method"].iloc[0])
    point = pd.read_csv(OUTPUT_DIR / "band_operating_point.csv").iloc[0]
    bands = {"release": float(point["release_threshold"]), "reject": float(point["reject_threshold"])}

    frame, features = load_shap()
    context = pd.read_parquet(OUTPUT_DIR / "multiseed_row_context.parquet")
    predictions = load_predictions(str(model_cfg["multi_seed"]["chosen_model"]))
    scored = predictions[["seed", "activation_id", "label", method]].rename(columns={method: "probability"})

    importance = global_importance(frame, features)
    by_typology = importance_by_typology(frame, features, context)
    shares = agent_history_share(importance, by_typology)
    cases = worked_cases(
        frame, features, scored, context, bands,
        int(model_cfg["explanations"]["worked_case_features"]),
    )

    for name, table in {
        "shap_global_importance": importance,
        "shap_importance_by_typology": by_typology,
        "shap_agent_history_share": shares,
        "shap_worked_cases": cases,
    }.items():
        table.to_csv(OUTPUT_DIR / f"{name}.csv", index=False, float_format="%.6g")

    pd.set_option("display.width", 240)
    pd.set_option("display.max_colwidth", 140)
    print(importance.head(12).round(5).to_string(index=False))
    print()
    print(shares.round(4).to_string(index=False))
    print()
    print(cases.to_string(index=False))


if __name__ == "__main__":
    main()
