import { z } from "zod";

/**
 * The scoring service's HTTP contract, mirrored from src/serve/schemas.py at
 * the repository root. Responses are validated against these schemas; a
 * response that does not match is treated as a scoring failure, never as a
 * score.
 */

export const reasonSchema = z.object({
  feature: z.string().min(1),
  is_agent_level: z.boolean(),
  direction: z.enum(["raises", "lowers"]),
  shap_value: z.number().finite(),
  description: z.string().min(1),
});

export const scoreResponseSchema = z
  .object({
    activation_id: z.string().min(1),
    mode: z.enum(["t0", "t7"]),
    feature_set: z.string().min(1),
    model_version: z.string().min(1),
    raw_score: z.number().finite(),
    calibrated_probability: z.number().min(0).max(1),
    band: z.enum(["auto_release", "review", "reject"]),
    release_threshold: z.number().min(0).max(1),
    reject_threshold: z.number().min(0).max(1),
    top_reasons: z.array(reasonSchema),
    /** Every feature the model scored, by name (issue #43). */
    feature_vector: z.record(z.number().finite()).refine((vector) => Object.keys(vector).length > 0, {
      message: "feature_vector is empty",
    }),
    scored_at: z.string().min(1),
  })
  .refine((body) => body.release_threshold <= body.reject_threshold, {
    message: "release_threshold is above reject_threshold",
  });

export type ScoreResponse = z.infer<typeof scoreResponseSchema>;
export type ScoreReason = z.infer<typeof reasonSchema>;
export type ScoringModeName = ScoreResponse["mode"];
export type BandName = ScoreResponse["band"];

/** Data dictionary section 2a, as the service expects it. */
export type ActivationEventPayload = {
  activation_id: string;
  agent_id: string;
  job_id: string;
  client_business_id: string;
  job_assigned_timestamp: string;
  job_accepted_timestamp: string;
  timestamp_submitted: string;
  device_id: string;
  device_os: string;
  app_version: string;
  ip_geolocation_region: string;
  network_type: "cellular" | "wifi";
  submission_gps_lat: number;
  submission_gps_lon: number;
  customer_msisdn_hash: string;
  sim_registration_date: string;
  activation_method: "qr_scan" | "manual_entry";
  proof_of_activation_hash: string | null;
  escrow_amount: number;
  commission_rate: number;
};

export type AgentRecordPayload = {
  agent_id: string;
  agent_registration_date: string;
  agent_home_lat: number;
  agent_home_lon: number;
};

export type PayoutCyclePayload = {
  cycle_id: number;
  cycle_start_date: string;
  cutoff_timestamp: string;
};

export type DownstreamActivityPayload = {
  event_day: number;
  customer_active_flag: boolean;
  transaction_count: number;
  topup_amount: number;
  usage_minutes: number;
  support_contact_flag: boolean;
  complaint_or_refund_flag: boolean;
  sim_active_flag: boolean;
};

export type ScoreRequestPayload = {
  mode: ScoringModeName;
  activation: ActivationEventPayload;
  agents: AgentRecordPayload[];
  recent_activations: ActivationEventPayload[];
  payout_calendar: PayoutCyclePayload[];
  downstream_activity: DownstreamActivityPayload[];
};
