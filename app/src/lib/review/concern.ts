import { formatDate, formatDistance, formatDuration } from "@/lib/format";
import { distanceKm } from "@/lib/geo";
import type { ReviewDetail } from "./detail";
import type { ReasonView } from "./reasons";
import { capitalise } from "./copy";

/**
 * "Check this first": the factor that raised the risk most, explained in
 * plain words with the checks a reviewer can make about it. The sentences say
 * what the factor means (from docs/data_dictionary.md at the repository
 * root) and point at this submission's own records. They contain no
 * statistics.
 */
export type ConcernAction =
  | { kind: "photo"; label: string; sequence: number }
  | { kind: "gallery"; label: string }
  | { kind: "map"; label: string }
  | { kind: "previous"; label: string; activationId: string }
  | { kind: "history"; label: string; agentId: string }
  | { kind: "ask"; label: string };

export type ConcernExplanation = { headline: string; sentences: string[]; actions: ConcernAction[] };

type Builder = (detail: ReviewDetail) => Omit<ConcernExplanation, "headline">;

const gallery = (detail: ReviewDetail): ConcernAction => ({ kind: "gallery", label: `View all ${detail.photos.length} photos` });
const history = (detail: ReviewDetail): ConcernAction => ({ kind: "history", label: "View the agent's full history", agentId: detail.agent.id });
const map: ConcernAction = { kind: "map", label: "Show the location on a map" };
const ask: ConcernAction = { kind: "ask", label: "Ask the agent for evidence" };

function outsidePhotoAction(detail: ReviewDetail): ConcernAction[] {
  const first = detail.evidenceSummary.outside[0];
  return first ? [{ kind: "photo", label: `Open photo ${first.sequence}`, sequence: first.sequence }] : [];
}

function previousAction(detail: ReviewDetail): ConcernAction[] {
  return detail.previous ? [{ kind: "previous", label: `Open the previous submission (${detail.previous.reference})`, activationId: detail.previous.id }] : [];
}

function outsideSentence(detail: ReviewDetail): string[] {
  const first = detail.evidenceSummary.outside[0];
  return first ? [`Photo ${first.sequence} was taken ${formatDistance(first.km)} outside the job area.`] : [];
}

function previousSentence(detail: ReviewDetail): string[] {
  const previous = detail.previous;
  if (!previous) return ["This is the agent's first recorded submission."];
  return [`The agent's previous submission was ${formatDuration(previous.gapMs)} earlier and ${formatDistance(previous.distanceKm)} away.`];
}

const LOCATION: Builder = (detail) => {
  const base = distanceKm(detail.agent.homeLat, detail.agent.homeLon, detail.job.areaLat, detail.job.areaLon);
  return {
    sentences: [
      "The model compares where the submission was made with where the agent is based.",
      `The job area itself is ${formatDistance(base)} from the agent's registered base (${detail.agent.homeAreaName}).`,
      ...outsideSentence(detail),
    ],
    actions: [map, ...outsidePhotoAction(detail)],
  };
};

const NETWORK: Builder = (detail) => ({
  sentences: [
    `The phone's network reported ${detail.submission.ipRegionName ?? detail.submission.ipRegion}, but its GPS fix is in ${detail.submission.gpsRegionName}.`,
    "That can mean the location was faked, or only that the phone was roaming or on a VPN.",
    ...outsideSentence(detail),
  ],
  actions: [map, ...outsidePhotoAction(detail)],
});

const TIMING: Builder = (detail) => ({
  sentences: [
    "The model looks at the time between the job being assigned, accepted and submitted. A very short time can mean no meeting took place.",
    ...previousSentence(detail),
  ],
  actions: [gallery(detail), ...previousAction(detail)],
});

const VELOCITY: Builder = (detail) => ({
  sentences: ["The model counts how many activations this agent submitted shortly before this one.", ...previousSentence(detail)],
  actions: [...previousAction(detail), history(detail)],
});

const DEVICE: Builder = (detail) => ({
  sentences: [
    "This is about how the submitting phone has been used across activations and agents.",
    "A phone shared between agents can be a family or shop phone as easily as a coordinated scheme.",
  ],
  actions: [history(detail)],
});

const TENURE: Builder = (detail) => ({
  sentences: [
    `This is about the agent, not this submission: ${detail.agent.name} joined on ${formatDate(detail.agent.registeredAt)}.`,
    "Check the submission's own evidence before letting the agent's record decide it.",
  ],
  actions: [history(detail), gallery(detail)],
});

const SIM: Builder = (detail) => ({
  sentences: [
    `The SIM was registered on ${formatDate(detail.submission.simRegisteredAt)}. New SIMs are normal for genuine sign-ups too.`,
    "Check that a photo shows the SIM pack and that it matches the registration date.",
  ],
  actions: [gallery(detail)],
});

const REPEAT_NUMBER: Builder = () => ({
  sentences: [
    "This customer number has been activated on the platform before.",
    "That can be a genuine re-registration; ask the agent if the evidence does not explain it.",
  ],
  actions: [ask],
});

const METHOD: Builder = (detail) => ({
  sentences: [
    "The customer's details were typed in rather than scanned from the SIM pack.",
    "Typing is normal when a code will not scan, but it means nothing physical was read.",
  ],
  actions: [gallery(detail)],
});

const PROOF: Builder = (detail) => ({
  sentences: [
    "No proof-of-activation file was attached to this submission.",
    `The agent sent ${detail.photos.length} photo${detail.photos.length === 1 ? "" : "s"}; check whether any of them shows the activation itself.`,
  ],
  actions: [gallery(detail), ask],
});

const CALENDAR: Builder = () => ({
  sentences: [
    "This is about timing against the payout calendar.",
    "Submissions just before a payout cutoff are one pattern of payout gaming, and also how many honest agents plan their week.",
  ],
  actions: [],
});

const DOWNSTREAM: Builder = () => ({
  sentences: [
    "This is the customer's first week of use, as reported by the client.",
    "Low use on its own is not evidence of fraud: many genuine customers sign up and then barely use the service.",
  ],
  actions: [ask],
});

const OTHER: Builder = (detail) => ({ sentences: ["Check the submitted evidence for this factor."], actions: [gallery(detail)] });

const BUILDERS: Record<string, Builder> = {
  distance_from_agent_home_km: LOCATION,
  ip_location_mismatch_flag: NETWORK,
  network_type_is_cellular: NETWORK,
  submission_latency_seconds: TIMING,
  job_acceptance_latency_seconds: TIMING,
  acceptance_to_submission_seconds: TIMING,
  submission_hour_of_day: TIMING,
  agent_activation_velocity_1h: VELOCITY,
  agent_activation_velocity_24h: VELOCITY,
  device_activations_7d: DEVICE,
  device_shared_agent_count_30d: DEVICE,
  distinct_devices_used_30d: DEVICE,
  agent_tenure_days: TENURE,
  sim_age_at_activation_days: SIM,
  customer_msisdn_prior_activation_count: REPEAT_NUMBER,
  activation_method_is_manual_entry: METHOD,
  proof_of_activation_missing_flag: PROOF,
  days_to_payout_cutoff: CALENDAR,
};

const DOWNSTREAM_FEATURES = [
  "customer_active_days_7d", "days_to_first_customer_activity", "transaction_count_7d", "topup_amount_total_7d",
  "usage_minutes_total_7d", "support_contact_count_7d", "complaint_or_refund_flag_7d", "sim_active_at_day7", "activity_dropoff_flag",
];

export function explainConcern(concern: ReasonView, detail: ReviewDetail): ConcernExplanation {
  const builder = BUILDERS[concern.feature] ?? (DOWNSTREAM_FEATURES.includes(concern.feature) ? DOWNSTREAM : OTHER);
  return { headline: capitalise(concern.description), ...builder(detail) };
}
