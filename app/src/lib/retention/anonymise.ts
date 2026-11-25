import { randomBytes } from "node:crypto";
import type { ActivationState, Prisma } from "@prisma/client";
import { recordAuditEvent } from "@/lib/activations/transition";
import { config } from "@/lib/config";
import { prisma, type Tx } from "@/lib/db";
import { removeActivationFiles } from "@/lib/evidence/storage";
import { maskPhone } from "@/lib/payments/redact";
import { fits, NO_DEADLINE } from "@/lib/time-budget";

/**
 * DR-11: past the retention limit, a settled submission keeps what the model
 * and the accounts need and loses what identifies the people involved.
 *
 * Removed: the evidence photos themselves, the customer's hashed and masked
 * number, the submitting device's id, the free text people typed (the agent's
 * note, the client's own evidence fields, review reasons, evidence requests
 * and dispute notes), and the agent's full payout number on a settled
 * payment. The GPS fix is coarsened to about a kilometre.
 *
 * Kept: the feature vector, probability, band, thresholds and reasons of
 * every score; the state history; every amount; and the evidence rows
 * themselves, so the record still says what was submitted and what was
 * decided.
 *
 * The audit log is never touched. It is append-only and anchored on chain, so
 * the free text it already holds stays there; docs/RETENTION.md says what
 * that means and what is proposed instead.
 */

/** The value written wherever a text column cannot be null. */
export const ANONYMISED = "anonymised";

/** Settled: nothing further is expected from anyone. A disputed or in-flight submission is not. */
export const SETTLED_STATES: readonly ActivationState[] = ["approved", "refused", "withdrawn"];

/** Allowed for one submission: a few storage deletes and one transaction. An assumption. */
export const RECORD_WORST_CASE_MS = 10_000;

export function retentionCutoff(now: Date, days: number = config().RETENTION_DAYS): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * Two decimal places of a degree: about 1.1 km of latitude, and the same of
 * longitude near the equator, where Kenya is. The point keeps the area the
 * work was done in and loses the doorway.
 */
export function coarsenDegrees(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A value that identifies nothing and collides with nothing, so old rows cannot be linked by it. */
function opaque(): string {
  return `${ANONYMISED}-${randomBytes(12).toString("hex")}`;
}

/**
 * The client's own evidence fields, with every typed value removed. A photo
 * field holds evidence sequence numbers, not personal data, so it is kept and
 * the page can still say which photos answered which field.
 */
export function clearedPayload(payload: unknown): Prisma.InputJsonValue {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  return Object.fromEntries(
    Object.entries(payload as Record<string, unknown>).map(([key, value]) => [key, Array.isArray(value) ? value : null]),
  ) as Prisma.InputJsonValue;
}

const eligibleWhere = (cutoff: Date): Prisma.ActivationWhereInput => ({
  anonymisedAt: null,
  state: { in: [...SETTLED_STATES] },
  // The last time the submission's own record changed, which is when it was settled.
  updatedAt: { lt: cutoff },
  // A payout still owed, failed or unconfirmed is an open matter: leave it alone.
  OR: [{ disbursement: { is: null } }, { disbursement: { status: "paid" } }],
});

export async function eligibleIds(db: Tx, cutoff: Date, limit: number): Promise<string[]> {
  const rows = await db.activation.findMany({
    where: eligibleWhere(cutoff),
    select: { id: true },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });
  return rows.map((row) => row.id);
}

export async function countEligible(db: Tx, cutoff: Date): Promise<number> {
  return db.activation.count({ where: eligibleWhere(cutoff) });
}

async function clearFreeText(tx: Prisma.TransactionClient, activationId: string): Promise<void> {
  await tx.reviewItem.updateMany({ where: { activationId }, data: { reason: null } });
  await tx.evidenceRequest.updateMany({ where: { activationId }, data: { message: ANONYMISED, responseNote: null } });
  await tx.dispute.updateMany({
    where: { activationId },
    data: { refusalReason: ANONYMISED, contestNote: null, resolutionNote: null },
  });
  // Notifications repeat the same reasons back to the agent and the reviewer.
  await tx.notification.updateMany({
    where: { activationId },
    data: { message: "This submission's record has been anonymised." },
  });
}

async function maskPayoutNumbers(tx: Prisma.TransactionClient, activationId: string): Promise<void> {
  const payout = await tx.payoutAuthorisation.findUnique({ where: { activationId } });
  if (payout) {
    await tx.payoutAuthorisation.update({ where: { id: payout.id }, data: { payoutMsisdn: maskPhone(payout.payoutMsisdn) } });
  }
  // Only ever a paid one: eligibility excludes every other state, and the
  // database trigger allows the masked form on a paid row only.
  const disbursement = await tx.disbursement.findUnique({ where: { activationId } });
  if (disbursement && disbursement.status === "paid") {
    await tx.disbursement.update({ where: { id: disbursement.id }, data: { payoutMsisdn: maskPhone(disbursement.payoutMsisdn) } });
  }
}

/**
 * Anonymises one submission. The photo bytes go first: if the transaction
 * then fails, the row is left un-marked and the next run does it again, which
 * is harmless, whereas marking the row before the bytes were gone would leave
 * them behind for ever.
 */
export async function anonymiseActivation(activationId: string, now: Date = new Date()): Promise<number> {
  const activation = await prisma.activation.findUniqueOrThrow({
    where: { id: activationId },
    include: { evidence: { select: { id: true } } },
  });
  if (activation.anonymisedAt) return 0;
  await removeActivationFiles(activation.id);
  return prisma.$transaction(async (tx) => {
    // Compare and swap on anonymisedAt, so two runs at once cannot both do it.
    const claimed = await tx.activation.updateMany({
      where: { id: activation.id, anonymisedAt: null },
      data: {
        customerMsisdnHash: opaque(),
        customerMsisdnMasked: ANONYMISED,
        deviceId: opaque(),
        gpsLat: coarsenDegrees(activation.gpsLat),
        gpsLon: coarsenDegrees(activation.gpsLon),
        gpsAccuracyM: null,
        agentNote: null,
        evidencePayload: clearedPayload(activation.evidencePayload),
        anonymisedAt: now,
      },
    });
    if (claimed.count === 0) return 0;
    await tx.evidenceItem.updateMany({
      where: { activationId: activation.id },
      data: { fileName: ANONYMISED, gpsLat: null, gpsLon: null, gpsAccuracyM: null, locationSource: "none" },
    });
    await clearFreeText(tx, activation.id);
    await maskPayoutNumbers(tx, activation.id);
    return activation.evidence.length;
  });
}

export type RetentionSummary = {
  retentionDays: number;
  cutoff: string;
  eligible: number;
  anonymised: number;
  evidenceFilesDeleted: number;
  deferred: number;
  failed: number;
};

/**
 * Anonymises every submission past the limit, newest cutoff first. With a
 * deadline (a cron request) it stops starting work that would not fit and
 * leaves the rest for the next run, as the other cron routes do.
 */
export async function runRetention(now: Date = new Date(), deadline: number = NO_DEADLINE): Promise<RetentionSummary> {
  const { RETENTION_DAYS, RETENTION_MAX_PER_RUN } = config();
  const cutoff = retentionCutoff(now, RETENTION_DAYS);
  const eligible = await countEligible(prisma, cutoff);
  const ids = await eligibleIds(prisma, cutoff, RETENTION_MAX_PER_RUN);
  const summary: RetentionSummary = {
    retentionDays: RETENTION_DAYS,
    cutoff: cutoff.toISOString(),
    eligible,
    anonymised: 0,
    evidenceFilesDeleted: 0,
    deferred: Math.max(eligible - ids.length, 0),
    failed: 0,
  };
  for (const [index, id] of ids.entries()) {
    if (!fits(deadline, RECORD_WORST_CASE_MS)) {
      summary.deferred += ids.length - index;
      break;
    }
    try {
      summary.evidenceFilesDeleted += await anonymiseActivation(id, now);
      summary.anonymised += 1;
    } catch (error) {
      // One submission's failure (a storage outage, say) must not stop the rest.
      console.error(`[retention] ${id} could not be anonymised`, error);
      summary.failed += 1;
    }
  }
  if (summary.anonymised > 0) {
    // Counts only: this event is itself permanent, so it names no submission,
    // no person and no field value.
    await recordAuditEvent(prisma, {
      kind: "retention_anonymised",
      detail:
        `Retention run: ${summary.anonymised} settled submission(s) anonymised after ${RETENTION_DAYS} day(s), ` +
        `${summary.evidenceFilesDeleted} evidence file(s) deleted.`,
      at: now,
    });
  }
  return summary;
}
