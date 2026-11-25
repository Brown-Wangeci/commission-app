/**
 * DR-11 demonstration on a local, seeded database with a short retention
 * period. It is never pointed at the hosted database: it refuses any APP_URL
 * or DATABASE_URL that is not local, because it back-dates a record and then
 * removes personal data from it.
 *
 * What it shows, for one settled submission:
 *   - the cron route answers 401 without the secret and 200 with it;
 *   - what the record held before and what it holds after;
 *   - that the photos were served before and are gone after;
 *   - that every audit event, its hash and its chain link are byte for byte
 *     what they were, that verification gives the same answer, and that the
 *     free text typed into the chain is still there (the DR-11 gap).
 *
 * Usage, from app/, with the app running against a seeded local database:
 *   APP_URL=http://localhost:3100 RETENTION_DAYS=1 npx tsx scripts/demo-retention.ts <out.json>
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { verifyActivationAudit } from "@/lib/audit/verify";
import { maskPhone } from "@/lib/payments/redact";
import { retentionCutoff, SETTLED_STATES, type RetentionSummary } from "@/lib/retention/anonymise";
import { signIn, type Session } from "./demo-client";
import { loadEnv } from "./load-env";

loadEnv();

const APP = process.env.APP_URL ?? "http://localhost:3100";
const DAY = 24 * 60 * 60 * 1000;
const log = (text: string) => console.log(`[retention-demo] ${text}`);

function requireLocal(): void {
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(APP)) throw new Error(`APP_URL ${APP} is not local; refusing.`);
  const host = new URL(process.env.DATABASE_URL ?? "postgres://nowhere/").hostname;
  if (!["localhost", "127.0.0.1"].includes(host)) throw new Error("DATABASE_URL is not local; refusing.");
}

/**
 * The seed's people and numbers are fictional, and this report is committed,
 * so it is masked like every other evidence file: phone numbers to their last
 * three digits, and any other long run of digits (an identity or SIM number a
 * client's own field might hold) to a count of them.
 */
const maskText = (text: string | null): string | null =>
  text === null
    ? null
    : text
        .replace(/\b(?:254|0)[17]\d{8}\b/g, (match) => maskPhone(match))
        .replace(/\d{9,}/g, (match) => `[${match.length} digits]`);

type Snapshot = Awaited<ReturnType<typeof snapshot>>;

async function snapshot(activationId: string) {
  const activation = await prisma.activation.findUniqueOrThrow({
    where: { id: activationId },
    include: {
      evidence: { orderBy: { sequence: "asc" } },
      reviewItems: { orderBy: { openedAt: "asc" } },
      evidenceRequests: true,
      dispute: true,
      decisions: { orderBy: { recordedAt: "asc" }, include: { reasons: true } },
      commission: true,
      payout: true,
      disbursement: true,
    },
  });
  return {
    state: activation.state,
    anonymisedAt: activation.anonymisedAt?.toISOString() ?? null,
    customerMsisdnMasked: activation.customerMsisdnMasked,
    customerMsisdnHashPrefix: `${activation.customerMsisdnHash.slice(0, 8)}...`,
    deviceIdPrefix: `${activation.deviceId.slice(0, 8)}...`,
    gpsLat: activation.gpsLat,
    gpsLon: activation.gpsLon,
    gpsAccuracyM: activation.gpsAccuracyM,
    agentNote: maskText(activation.agentNote),
    evidencePayload: JSON.parse(maskText(JSON.stringify(activation.evidencePayload)) ?? "null"),
    evidence: activation.evidence.map((item) => ({ sequence: item.sequence, fileName: item.fileName, gpsLat: item.gpsLat, gpsLon: item.gpsLon, locationSource: item.locationSource, sha256Prefix: `${item.sha256.slice(0, 8)}...` })),
    reviewItemReasons: activation.reviewItems.map((item) => maskText(item.reason)),
    evidenceRequests: activation.evidenceRequests.map((request) => ({ message: maskText(request.message), responseNote: maskText(request.responseNote) })),
    dispute: activation.dispute ? { refusalReason: maskText(activation.dispute.refusalReason), contestNote: maskText(activation.dispute.contestNote) } : null,
    payoutMsisdnMaskedForThisReport: activation.payout ? maskPhone(activation.payout.payoutMsisdn) : null,
    payoutMsisdnIsFullNumber: activation.payout ? /^\d{9,}$/.test(activation.payout.payoutMsisdn.replace(/\D/g, "")) && !activation.payout.payoutMsisdn.includes("*") : null,
    disbursement: activation.disbursement ? { status: activation.disbursement.status, amountCents: activation.disbursement.amountCents, payoutMsisdnIsMasked: activation.disbursement.payoutMsisdn.includes("*") } : null,
    kept: {
      reference: activation.reference,
      submittedAt: activation.submittedAt.toISOString(),
      decisions: activation.decisions.map((decision) => ({ mode: decision.mode, band: decision.band, probability: decision.probability, reasons: decision.reasons.length, featureVectorFields: decision.featureVector ? Object.keys(decision.featureVector as object).length : 0 })),
      commissionCents: activation.commission?.amountCents ?? null,
      activityDays: await prisma.customerActivityDay.count({ where: { activationId } }),
    },
  };
}

async function auditState(activationId: string) {
  const events = await prisma.auditEvent.findMany({ where: { activationId }, orderBy: { id: "asc" }, include: { chain: true } });
  const verification = await verifyActivationAudit(prisma, activationId);
  return {
    events: events.map((event) => ({ id: String(event.id), kind: event.kind, sequence: event.chain ? String(event.chain.sequence) : null, hash: event.chain?.hash ?? null, detail: maskText(event.detail) })),
    verification: { status: verification.status, summary: verification.summary },
  };
}

/** Signed in as the seeded reviewer, who may read the photos, so the answer says whether the bytes are still there. */
async function photoStatus(session: Session, evidenceId: string): Promise<number> {
  return (await fetch(`${APP}/api/evidence/${evidenceId}`, { headers: { cookie: session.cookie }, redirect: "manual" })).status;
}

/**
 * The submission that shows the most: settled, with photos, and with text a
 * person typed (a review reason, an evidence request or a dispute), so the
 * report can show that text both cleared from the record and still in the chain.
 */
async function pickActivation(): Promise<string> {
  const settled = { state: { in: [...SETTLED_STATES] }, anonymisedAt: null, evidence: { some: {} } };
  const withText = {
    ...settled,
    OR: [{ reviewItems: { some: { reason: { not: null } } } }, { evidenceRequests: { some: {} } }, { dispute: { isNot: null } }],
  };
  const oldest = { orderBy: { submittedAt: "asc" as const }, select: { id: true } };
  const choice =
    (await prisma.activation.findFirst({ where: { ...withText, disbursement: { status: "paid" } }, ...oldest })) ??
    (await prisma.activation.findFirst({ where: withText, ...oldest })) ??
    (await prisma.activation.findFirst({ where: settled, ...oldest }));
  if (!choice) throw new Error("No settled submission with evidence in this database; seed it first.");
  return choice.id;
}

async function callCron(secret: string | undefined): Promise<{ status: number; summary: RetentionSummary | null }> {
  const response = await fetch(`${APP}/api/cron/retention`, {
    method: "POST",
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
  const body = response.ok ? ((await response.json()) as { summary: RetentionSummary }) : null;
  return { status: response.status, summary: body?.summary ?? null };
}

async function main(): Promise<void> {
  const out = process.argv[2];
  if (!out) throw new Error("Usage: demo-retention.ts <out.json>");
  requireLocal();
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error("CRON_SECRET is not set, so the route answers 404.");
  const retentionDays = Number(process.env.RETENTION_DAYS ?? 1);

  const activationId = await pickActivation();
  const reference = (await prisma.activation.findUniqueOrThrow({ where: { id: activationId } })).reference;
  log(`app ${APP}; ${reference} chosen; retention ${retentionDays} day(s)`);

  // Settle it well before the limit. Only this column is touched, and only to
  // make a short demonstration possible; nothing else about the row changes.
  const settledAt = new Date(Date.now() - (retentionDays + 9) * DAY);
  await prisma.$executeRaw`UPDATE "Activation" SET "updatedAt" = ${settledAt} WHERE id = ${activationId}`;

  const reviewer = await signIn("reviewer@ledgerfield.test");
  const firstEvidenceId = (await prisma.evidenceItem.findFirstOrThrow({ where: { activationId }, orderBy: { sequence: "asc" } })).id;
  const before = await snapshot(activationId);
  const auditBefore = await auditState(activationId);
  const photoBefore = await photoStatus(reviewer, firstEvidenceId);

  const refused = await callCron(undefined);
  log(`POST /api/cron/retention without the secret: ${refused.status}`);
  const run = await callCron(secret);
  log(`POST /api/cron/retention with the secret: ${run.status}; ${JSON.stringify(run.summary)}`);

  const after = await snapshot(activationId);
  const auditAfter = await auditState(activationId);
  const photoAfter = await photoStatus(reviewer, firstEvidenceId);

  const hashesUnchanged = JSON.stringify(auditBefore.events) === JSON.stringify(auditAfter.events);
  const detailsStillInChain = auditAfter.events.map((event) => `${event.kind}: ${event.detail ?? ""}`);

  const report = {
    requirement: "DR-11: retention limit, then anonymisation keeping the aggregates retraining needs",
    ranAt: new Date().toISOString(),
    app: APP,
    database: "local, seeded; the seed's people, numbers and photos are fictional",
    settings: { RETENTION_DAYS: retentionDays, cutoff: retentionCutoff(new Date(), retentionDays).toISOString(), settledAtForThisDemo: settledAt.toISOString() },
    cronRoute: { withoutSecret: refused.status, withSecret: run.status },
    summary: run.summary,
    activation: { reference, before, after },
    evidenceFile: { id: firstEvidenceId, statusBefore: photoBefore, statusAfter: photoAfter, readAs: "reviewer@ledgerfield.test", note: "200 means an administrator could fetch the photo; 404 means the stored bytes are gone." },
    auditChain: {
      untouched: hashesUnchanged,
      eventsBefore: auditBefore.events.length,
      eventsAfter: auditAfter.events.length,
      verificationBefore: auditBefore.verification,
      verificationAfter: auditAfter.verification,
      detailsStillInChain,
      note: "Every detail the chain still holds for this submission, after its record was anonymised. The chain is append-only and anchored, so nothing here is changed or removed; the text people typed is the DR-11 gap.",
    },
  };
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  log(`audit events unchanged: ${hashesUnchanged}; photo ${photoBefore} -> ${photoAfter}; written ${out}`);
}

main()
  .catch((error) => {
    console.error(`[retention-demo] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
