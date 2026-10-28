import type { ScoreResponse } from "@/lib/scoring/contract";

/**
 * Builds a scoring-service response for tests. The thresholds default to the
 * values the served models report (T7 0.267 / 0.667, T0 0.301 / 0.729); they
 * exist here only so tests have realistic input, and the app never reads them
 * from anywhere but a service response.
 */
export function fakeResponse(overrides: Partial<ScoreResponse> & { activation_id: string }): ScoreResponse {
  const mode = overrides.mode ?? "t0";
  const thresholds = mode === "t0" ? [0.301471, 0.729167] : [0.266667, 0.666667];
  return {
    mode,
    feature_set: mode,
    model_version: `${mode}_none-isotonic-v1`,
    raw_score: 0.4,
    calibrated_probability: 0.42,
    band: "review",
    release_threshold: thresholds[0],
    reject_threshold: thresholds[1],
    top_reasons: [
      {
        feature: "distance_from_agent_home_km",
        is_agent_level: false,
        direction: "raises",
        shap_value: 0.81,
        description: "the activation was 23.4 km from the agent's registered base",
      },
      {
        feature: "agent_tenure_days",
        is_agent_level: true,
        direction: "lowers",
        shap_value: -0.52,
        description: "the agent has been on the platform 412 days",
      },
      {
        feature: "submission_hour_of_day",
        is_agent_level: false,
        direction: "raises",
        shap_value: 0.12,
        description: "the activation was submitted at 10:00",
      },
    ],
    scored_at: new Date().toISOString(),
    ...overrides,
  };
}
