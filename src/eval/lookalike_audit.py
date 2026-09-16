"""Does every fraud signature have a legitimate counterpart that overlaps it?

Usage: python -m src.eval.lookalike_audit

This generalises how the held-job acceptance latency defect was found. For each
fraud typology and each observable feature it takes the tail of that typology's
distribution holding a fixed share of its rows (the side where the typology sits
relative to legitimate rows) and asks what share of legitimate rows fall in the
same region. A signature whose region contains almost no legitimate rows is a
near-deterministic separator, which CLAUDE.md forbids.

Binary features are handled separately: the "region" is the flag value the
typology prefers, and the counterpart share is the legitimate rate of that value.
"""

from __future__ import annotations

from typing import Any, Dict, List

import numpy as np
import pandas as pd

from ..generator import config as config_module
from ..generator.typologies import FRAUD_TYPOLOGIES
from ..train import data as data_module

OUTPUT_DIR = config_module.REPO_ROOT / "outputs"

# Documentation, not parameters: which configured legitimate lookalike is meant
# to cover each fraud signature. Features not listed here have no typology
# specific mechanism in the generator; they are drawn from the same distribution
# for both classes, so overlap is structural.
LOOKALIKE_COVER: Dict[str, str] = {
    "job_acceptance_latency_seconds": "batch_acceptance (honest agents who accept jobs and work them later)",
    "submission_latency_seconds": "fast_submission_latency_minutes (honest queue at a drive)",
    "acceptance_to_submission_seconds": "fast_submission_latency_minutes (honest queue at a drive)",
    "distance_from_agent_home_km": "fixed_site_agent_share (honest agents working one fixed site)",
    "sim_age_at_activation_days": "same_day_sim_share (customer buys and registers the SIM at signup)",
    "device_shared_agent_count_30d": "device_sharing_team_share (honest team sharing one enrolment device)",
    "device_activations_7d": "device_sharing_team_share (honest team sharing one enrolment device)",
    "distinct_devices_used_30d": "devices_per_agent (honest agents with more than one handset)",
    "customer_msisdn_prior_activation_count": "repeat_msisdn_rate (genuine reactivation)",
    "agent_activation_velocity_1h": "burst_intra_day_spread_hours (campaign and market day clustering)",
    "agent_activation_velocity_24h": "campaign and market day volume multipliers",
    "days_to_payout_cutoff": "end_cycle_push (honest agents rushing the same deadline)",
    "submission_hour_of_day": "legit_behaviour.submission_hour (honest late-evening component)",
    "customer_active_days_7d": "mode_mix.dormant (genuine but dormant customers)",
    "days_to_first_customer_activity": "mode_mix.dormant (genuine but dormant customers)",
    "transaction_count_7d": "mode_mix.dormant (genuine but dormant customers)",
    "topup_amount_total_7d": "mode_mix.dormant (genuine but dormant customers)",
    "usage_minutes_total_7d": "mode_mix.dormant (genuine but dormant customers)",
    "activity_dropoff_flag": "mode_mix.trial_lapse (genuine try-then-lapse customers)",
    "sim_active_at_day7": "sim_deactivation_hazard (genuine accounts going inactive)",
    "complaint_or_refund_flag_7d": "legit_behaviour.complaint_daily_prob",
    "support_contact_count_7d": "legit_behaviour.support_contact_daily_prob",
    "ip_location_mismatch_flag": "legit_behaviour.ip_mismatch_rate (roaming or VPN)",
    "activation_method_is_manual_entry": "legit_behaviour.manual_entry_rate",
    "proof_of_activation_missing_flag": "legit_behaviour.proof_missing_rate",
    "network_type_is_cellular": "legit_behaviour.cellular_rate (honest wifi submissions)",
    "agent_tenure_days": "population.tenure_days (overlapping tenure distributions)",
}


def _is_binary(values: np.ndarray) -> bool:
    return np.unique(values).size <= 2


def _binary_row(values: np.ndarray, legit: np.ndarray, members: np.ndarray) -> Dict[str, Any]:
    """The region is the flag value this typology prefers."""
    typology_rate = float(values[members].mean())
    legit_rate = float(values[legit].mean())
    prefers_one = typology_rate >= legit_rate
    region_value = 1.0 if prefers_one else 0.0
    in_region = values == region_value
    return {
        "direction": f"flag == {int(region_value)}",
        "threshold": region_value,
        "typology_share_in_region": typology_rate if prefers_one else 1.0 - typology_rate,
        "legitimate_share_in_region": legit_rate if prefers_one else 1.0 - legit_rate,
        "fraud_purity_of_region": float((~legit)[in_region].mean()) if in_region.any() else np.nan,
    }


def _continuous_row(
    values: np.ndarray, legit: np.ndarray, members: np.ndarray, tail_mass: float
) -> Dict[str, Any]:
    """The region is the tail holding tail_mass of this typology, on its own side."""
    upper = np.median(values[members]) >= np.median(values[legit])
    quantile = 1.0 - tail_mass if upper else tail_mass
    threshold = float(np.quantile(values[members], quantile))
    in_region = values >= threshold if upper else values <= threshold
    return {
        "direction": "upper tail" if upper else "lower tail",
        "threshold": threshold,
        "typology_share_in_region": float(in_region[members].mean()),
        "legitimate_share_in_region": float(in_region[legit].mean()),
        "fraud_purity_of_region": float((~legit)[in_region].mean()) if in_region.any() else np.nan,
    }


def audit(dataset: data_module.Dataset, model_cfg: Dict[str, Any]) -> pd.DataFrame:
    cfg = model_cfg["investigations"]
    tail_mass = float(cfg["lookalike_audit_tail_mass"])
    flag_share = float(cfg["lookalike_audit_flag_share"])
    legit = dataset.labels == 0
    rows: List[Dict[str, Any]] = []
    for typology in FRAUD_TYPOLOGIES:
        members = dataset.typology == typology
        for name in dataset.features.columns:
            values = dataset.features[name].to_numpy(dtype=float)
            measured = (
                _binary_row(values, legit, members)
                if _is_binary(values)
                else _continuous_row(values, legit, members, tail_mass)
            )
            rows.append({
                "typology": typology,
                "feature": name,
                **measured,
                "legitimate_counterpart": LOOKALIKE_COVER.get(name, "none configured"),
            })
    table = pd.DataFrame(rows)
    table["flagged_no_counterpart"] = table["legitimate_share_in_region"] < flag_share
    return table.sort_values(["legitimate_share_in_region", "typology"]).reset_index(drop=True)


def main() -> None:
    model_cfg = config_module.load_config(config_module.MODEL_CONFIG)
    dataset = data_module.load_dataset()
    table = audit(dataset, model_cfg)
    table.to_csv(OUTPUT_DIR / "lookalike_audit.csv", index=False, float_format="%.6g")
    pd.set_option("display.width", 250)
    pd.set_option("display.max_columns", 30)
    flagged = table[table["flagged_no_counterpart"]]
    print(f"flagged signatures (legitimate share below {model_cfg['investigations']['lookalike_audit_flag_share']}):")
    print(flagged.drop(columns=["flagged_no_counterpart"]).to_string(index=False))
    print()
    print("ten thinnest counterparts overall:")
    print(table.head(10)[["typology", "feature", "direction", "typology_share_in_region",
                          "legitimate_share_in_region", "fraud_purity_of_region"]].round(5).to_string(index=False))


if __name__ == "__main__":
    main()
