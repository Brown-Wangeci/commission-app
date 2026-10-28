import type { Activation, Agent, Assignment, CustomerActivityDay, Job, PayoutCycle } from "@prisma/client";
import type { Tx } from "@/lib/db";
import type {
  ActivationEventPayload,
  AgentRecordPayload,
  DownstreamActivityPayload,
  PayoutCyclePayload,
  ScoreRequestPayload,
  ScoringModeName,
} from "./contract";
import { toServiceTime } from "./time";

/**
 * Builds the /score request for one activation from the observable record
 * only. Nothing here reads a decision, a review outcome or any label.
 *
 * History window: the longest trailing window the model uses is 90 days
 * (`features.msisdn_history_days` in config/generator.yaml), so every
 * earlier activation within 90 days that shares the agent, the device or the
 * customer number is sent. Calendar: cycles from 30 days before to 60 days
 * after submission, which always includes the next cutoff.
 */
export const HISTORY_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

type ActivationWithContext = Activation & {
  assignment: Assignment & { hold: { amountKsh: number } | null };
  job: Job;
};

export class PayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadError";
  }
}

function activationEvent(activation: ActivationWithContext): ActivationEventPayload {
  const { assignment, job } = activation;
  if (!assignment.acceptedAt) throw new PayloadError("the assignment was never accepted");
  if (!assignment.hold) throw new PayloadError("the assignment has no escrow hold");
  return {
    activation_id: activation.id,
    agent_id: activation.agentId,
    job_id: assignment.id,
    client_business_id: job.clientId,
    job_assigned_timestamp: toServiceTime(assignment.assignedAt),
    job_accepted_timestamp: toServiceTime(assignment.acceptedAt),
    timestamp_submitted: toServiceTime(activation.submittedAt),
    device_id: activation.deviceId,
    device_os: activation.deviceOs,
    app_version: activation.appVersion,
    ip_geolocation_region: activation.ipRegion,
    network_type: activation.networkType,
    submission_gps_lat: activation.gpsLat,
    submission_gps_lon: activation.gpsLon,
    customer_msisdn_hash: activation.customerMsisdnHash,
    sim_registration_date: toServiceTime(activation.simRegisteredAt),
    activation_method: activation.activationMethod,
    proof_of_activation_hash: activation.proofHash,
    escrow_amount: assignment.hold.amountKsh,
    commission_rate: job.commissionRate,
  };
}

function agentRecord(agent: Agent): AgentRecordPayload {
  return {
    agent_id: agent.id,
    agent_registration_date: toServiceTime(agent.registeredAt),
    agent_home_lat: agent.homeLat,
    agent_home_lon: agent.homeLon,
  };
}

function payoutCycle(cycle: PayoutCycle): PayoutCyclePayload {
  return {
    cycle_id: cycle.id,
    cycle_start_date: toServiceTime(cycle.startsAt),
    cutoff_timestamp: toServiceTime(cycle.cutoffAt),
  };
}

function activityDay(day: CustomerActivityDay): DownstreamActivityPayload {
  return {
    event_day: day.day,
    customer_active_flag: day.customerActive,
    transaction_count: day.transactionCount,
    topup_amount: day.topupAmountKsh,
    usage_minutes: day.usageMinutes,
    support_contact_flag: day.supportContact,
    complaint_or_refund_flag: day.complaintOrRefund,
    sim_active_flag: day.simActive,
  };
}

const withContext = { assignment: { include: { hold: true } }, job: true } as const;

async function loadHistory(db: Tx, activation: Activation): Promise<ActivationWithContext[]> {
  const since = new Date(activation.submittedAt.getTime() - HISTORY_DAYS * DAY_MS);
  return db.activation.findMany({
    where: {
      id: { not: activation.id },
      submittedAt: { gte: since, lt: activation.submittedAt },
      OR: [
        { agentId: activation.agentId },
        { deviceId: activation.deviceId },
        { customerMsisdnHash: activation.customerMsisdnHash },
      ],
    },
    include: withContext,
    orderBy: { submittedAt: "asc" },
  });
}

async function loadCalendar(db: Tx, submittedAt: Date): Promise<PayoutCycle[]> {
  const cycles = await db.payoutCycle.findMany({
    where: {
      cutoffAt: { gte: new Date(submittedAt.getTime() - 30 * DAY_MS) },
      startsAt: { lte: new Date(submittedAt.getTime() + 60 * DAY_MS) },
    },
    orderBy: { cutoffAt: "asc" },
  });
  if (!cycles.some((cycle) => cycle.cutoffAt >= submittedAt)) {
    throw new PayloadError("the payout calendar has no cutoff after the submission time");
  }
  return cycles;
}

async function loadActivity(db: Tx, activationId: string): Promise<DownstreamActivityPayload[]> {
  const days = await db.customerActivityDay.findMany({ where: { activationId }, orderBy: { day: "asc" } });
  if (days.length === 0) {
    throw new PayloadError("no first-week customer activity has been reported for this activation");
  }
  return days.map(activityDay);
}

export async function buildScoreRequest(
  db: Tx,
  activationId: string,
  mode: ScoringModeName,
): Promise<ScoreRequestPayload> {
  const activation = await db.activation.findUniqueOrThrow({ where: { id: activationId }, include: withContext });
  const history = await loadHistory(db, activation);
  const agentIds = [...new Set([activation.agentId, ...history.map((item) => item.agentId)])];
  const agents = await db.agent.findMany({ where: { id: { in: agentIds } } });
  const calendar = await loadCalendar(db, activation.submittedAt);
  return {
    mode,
    activation: activationEvent(activation),
    agents: agents.map(agentRecord),
    recent_activations: history.filter((item) => item.assignment.acceptedAt && item.assignment.hold).map(activationEvent),
    payout_calendar: calendar.map(payoutCycle),
    downstream_activity: mode === "t7" ? await loadActivity(db, activation.id) : [],
  };
}
