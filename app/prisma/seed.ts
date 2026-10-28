/**
 * Seed data for Ledgerfield (issue #16).
 *
 * Every activation goes through the real code paths: assignment and escrow,
 * submission with evidence, T0 scoring by the real scoring service, the
 * durable T7 job, and reviewer and agent actions. No scoring decision is
 * written by hand: every probability, band, threshold and reason shown in the
 * app comes from the scoring service. The service must therefore be running
 * (SCORING_SERVICE_URL) when this runs.
 *
 * Seed people, businesses and photos are fictional. Photos are flat
 * placeholder images.
 *
 * Safe to rerun: it refuses to touch a database that holds any account
 * outside the seed's own @ledgerfield.test domain, and otherwise clears the
 * previous seed and builds it again.
 */
import { loadEnv } from "../scripts/load-env";

loadEnv();
// Seed outcomes are tuned against a seven-day hold window; a shorter demo
// window in .env applies to new submissions only.
process.env.HOLD_WINDOW_SECONDS = String(7 * 24 * 60 * 60);

import fs from "node:fs/promises";
import path from "node:path";
import type { ActivationState, Agent, Job } from "@prisma/client";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { hashPassword } from "@/lib/auth/password";
import { acceptAssignment, assignJob, fundJob } from "@/lib/escrow/holds";
import { recordSubmission, submitActivation, type PhotoInput, type SubmissionInput } from "@/lib/activations/submit";
import { respondToEvidenceRequest, withdrawActivation } from "@/lib/activations/agent-actions";
import { approveActivation, refuseActivation, requestEvidence } from "@/lib/review/actions";
import { contestRefusal } from "@/lib/disputes/disputes";
import { runScoringJob } from "@/lib/scoring/runner";
import { cycleIndexFor, cycleRow } from "@/lib/payouts/calendar";
import { placeholderPng } from "./seed-support/placeholder-png";

const SEED_DOMAIN = "@ledgerfield.test";
const PASSWORD = "ledgerfield-demo";
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NAIROBI_OFFSET = 3 * HOUR;

// ---------------------------------------------------------------- utilities

/** Deterministic pseudo-random numbers so the seed is the same on every run. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(20261028);
const between = (low: number, high: number) => low + random() * (high - low);

/** A moment `daysAgo` days before `base`, at the given Nairobi wall-clock time. */
function nairobiTime(base: Date, daysAgo: number, hour: number, minute: number): Date {
  const local = new Date(base.getTime() + NAIROBI_OFFSET);
  const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - daysAgo * DAY;
  return new Date(day + hour * HOUR + minute * MINUTE - NAIROBI_OFFSET);
}

/**
 * The latest moment `daysBefore` days and `minutesBefore` minutes before a
 * payout cutoff that is at least `minDaysAgo` days in the past. Placing the
 * risky cases at a fixed distance from a cutoff makes the model's
 * days-to-cutoff input, and so the seed's outcome, the same on any run date.
 */
function beforeCutoff(now: Date, minDaysAgo: number, daysBefore = 2, minutesBefore = 20): Date {
  const latest = now.getTime() - minDaysAgo * DAY;
  for (let id = cycleIndexFor(now) + 1; ; id -= 1) {
    const at = cycleRow(id).cutoffAt.getTime() - daysBefore * DAY - minutesBefore * MINUTE;
    if (at <= latest) return new Date(at);
  }
}

let customerCounter = 0;
function nextCustomer(): string {
  customerCounter += 1;
  return `07${String(20000000 + customerCounter * 7919).slice(-8)}`;
}

let imageCounter = 0;
function photoFile(): File {
  imageCounter += 1;
  return new File([placeholderPng(imageCounter)], `evidence-${imageCounter}.png`, { type: "image/png" });
}

type Point = { lat: number; lon: number };
const jitter = (point: Point, metres: number): Point => ({
  lat: point.lat + ((random() - 0.5) * 2 * metres) / 111_320,
  lon: point.lon + ((random() - 0.5) * 2 * metres) / 111_320,
});

function photos(count: number, around: Point, start: Date, spanMinutes: number, outside?: { index: number; at: Point }): PhotoInput[] {
  return Array.from({ length: count }, (_, i) => {
    const at = outside && outside.index === i + 1 ? outside.at : jitter(around, 120);
    return {
      file: photoFile(),
      capturedAt: new Date(start.getTime() + (spanMinutes * MINUTE * i) / Math.max(1, count - 1)),
      gpsLat: at.lat,
      gpsLon: at.lon,
      gpsAccuracyM: Math.round(between(5, 14)),
      locationSource: "device",
    };
  });
}

type Activity = "engaged" | "light" | "dormant" | "dormant_lapsed" | "dormant_complaint";

async function reportWeek(activationId: string, kind: Activity): Promise<void> {
  const days = Array.from({ length: 8 }, (_, day) => {
    const active =
      kind === "engaged" ? random() < 0.85 : kind === "light" ? day === 0 || day === 3 || day === 6 : false;
    return {
      activationId,
      day,
      customerActive: active,
      transactionCount: active ? Math.round(between(1, 4)) : 0,
      topupAmountKsh: active ? Math.round(between(20, 150)) : 0,
      usageMinutes: active ? Math.round(between(5, 40)) : 0,
      supportContact: kind === "dormant_complaint" && day === 2,
      complaintOrRefund: kind === "dormant_complaint" && day === 2,
      simActive: !(kind === "dormant_lapsed" || kind === "dormant_complaint") || day < 4,
    };
  });
  await prisma.customerActivityDay.createMany({ data: days });
}

/** Closes the hold as the scheduler would at the end of the window. */
async function closeHold(activationId: string, activity: Activity): Promise<ActivationState> {
  await reportWeek(activationId, activity);
  const activation = await prisma.activation.findUniqueOrThrow({ where: { id: activationId } });
  if (activation.state !== "held") return activation.state;
  const job = await prisma.scoringJob.findUniqueOrThrow({ where: { activationId_mode: { activationId, mode: "t7" } } });
  await runScoringJob(job.id, new Date(activation.holdClosesAt!.getTime() + MINUTE));
  return (await prisma.activation.findUniqueOrThrow({ where: { id: activationId } })).state;
}

// ---------------------------------------------------------------- people

type SeedAgent = Agent & { name: string; device: string; home: Point };

async function createUser(email: string, name: string, role: "admin" | "agent" | "client") {
  return prisma.user.create({ data: { email, name, role, passwordHash: await hashPassword(PASSWORD) } });
}

async function createAgent(spec: { key: string; name: string; tenureDays: number; home: Point; area: string; msisdn: string }, now: Date): Promise<SeedAgent> {
  const user = await createUser(`${spec.key}${SEED_DOMAIN}`, spec.name, "agent");
  const agent = await prisma.agent.create({
    data: {
      userId: user.id,
      payoutMsisdn: spec.msisdn,
      registeredAt: new Date(now.getTime() - spec.tenureDays * DAY),
      homeLat: spec.home.lat,
      homeLon: spec.home.lon,
      homeAreaName: spec.area,
    },
  });
  return { ...agent, name: spec.name, device: `dev-${spec.key}-${spec.msisdn.slice(-4)}`, home: spec.home };
}

// ---------------------------------------------------------------- submissions

type SubmitSpec = {
  agent: SeedAgent;
  job: Job;
  at: Date;
  acceptedMinutesBefore?: number;
  assignedMinutesBefore?: number;
  gps?: Point;
  photoCount?: number;
  outside?: { index: number; at: Point };
  overrides?: Partial<SubmissionInput>;
  device?: Partial<SubmissionInput["device"]>;
  queueOnly?: boolean;
};

let adminId = "";

async function submit(spec: SubmitSpec): Promise<string> {
  const assignedAt = new Date(spec.at.getTime() - (spec.assignedMinutesBefore ?? between(90, 240)) * MINUTE);
  const acceptedAt = new Date(spec.at.getTime() - (spec.acceptedMinutesBefore ?? between(40, 80)) * MINUTE);
  const assignment = await assignJob({ jobId: spec.job.id, agentId: spec.agent.id, assignedById: adminId, at: assignedAt });
  await acceptAssignment({ assignmentId: assignment.id, agentId: spec.agent.id, at: acceptedAt });
  const area = { lat: spec.job.areaLat, lon: spec.job.areaLon };
  const gps = spec.gps ?? jitter(area, 150);
  const count = spec.photoCount ?? Math.round(between(3, 6));
  const input: SubmissionInput = {
    agentId: spec.agent.id,
    assignmentId: assignment.id,
    customerMsisdn: nextCustomer(),
    simRegisteredAt: new Date(spec.at.getTime() - between(6, 60) * DAY),
    activationMethod: "qr_scan",
    gpsLat: gps.lat,
    gpsLon: gps.lon,
    gpsAccuracyM: Math.round(between(4, 12)),
    device: { deviceId: spec.agent.device, deviceOs: "android", appVersion: "3.4.0", networkType: "cellular", ipRegion: null, ...spec.device },
    agentNote: null,
    photos: photos(count, gps, new Date(spec.at.getTime() - 12 * MINUTE), 9, spec.outside),
    proof: photoFile(),
    submittedAt: spec.at,
    ...spec.overrides,
  };
  if (spec.queueOnly) return (await recordSubmission(input)).activationId;
  return (await submitActivation(input)).activationId;
}

/** A past activation taken all the way through the hold window. */
async function history(spec: SubmitSpec, activity: Activity, onReview: "approve" | "refuse"): Promise<string> {
  const id = await submit(spec);
  const state = await closeHold(id, activity);
  if (state === "in_review") {
    const at = new Date(spec.at.getTime() + 7 * DAY + 5 * HOUR);
    const reason = onReview === "approve" ? "Customer reached by phone and confirmed the sign-up." : "Customer says they never signed up.";
    if (onReview === "approve") await approveActivation({ activationId: id, reviewerId: adminId, reason, at });
    else await refuseActivation({ activationId: id, reviewerId: adminId, reason, at });
  }
  return id;
}

// ---------------------------------------------------------------- safety

async function ensureServiceUp(): Promise<void> {
  const url = new URL("/health", config().SCORING_SERVICE_URL);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const body = (await response.json()) as { loaded?: boolean };
    if (!body.loaded) throw new Error("models not loaded");
  } catch (error) {
    throw new Error(
      `The scoring service at ${url.origin} is not answering (${String(error)}). ` +
        "Start it first (see app/README.md); the seed never invents scores.",
    );
  }
}

async function clearPreviousSeed(): Promise<void> {
  const outsiders = await prisma.user.count({ where: { NOT: { email: { endsWith: SEED_DOMAIN } } } });
  if (outsiders > 0) {
    throw new Error(
      `This database has ${outsiders} account(s) that the seed did not create. Refusing to clear it. ` +
        "Point DATABASE_URL at an empty database to seed.",
    );
  }
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
  const keep = new Set(["_prisma_migrations", "ActivationTransitionRule"]);
  const tables = rows.map((r) => r.tablename).filter((t) => !keep.has(t)).map((t) => `"${t}"`);
  if (tables.length > 0) await prisma.$executeRawUnsafe(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.$executeRawUnsafe(`ALTER SEQUENCE "activation_reference_seq" RESTART WITH 1`);
  await fs.rm(path.resolve(process.cwd(), config().EVIDENCE_STORAGE_DIR), { recursive: true, force: true });
}

// ---------------------------------------------------------------- the data

const PLACES = {
  gikomba: { lat: -1.2836, lon: 36.834 },
  trm: { lat: -1.219, lon: 36.888 },
  eastleigh: { lat: -1.274, lon: 36.851 },
  kibuye: { lat: -0.0995, lon: 34.768 },
  githurai: { lat: -1.201, lon: 36.912 },
  kawangware: { lat: -1.283, lon: 36.748 },
};

async function main(): Promise<void> {
  await ensureServiceUp();
  await clearPreviousSeed();
  const now = new Date();
  const expected: Array<{ label: string; id: string; want: ActivationState }> = [];

  const amina = await createUser(`reviewer${SEED_DOMAIN}`, "Amina Otieno", "admin");
  await createUser(`reviewer2${SEED_DOMAIN}`, "David Mwangi", "admin");
  adminId = amina.id;

  const mwangaOwner = await createUser(`client${SEED_DOMAIN}`, "Joyce Njeri", "client");
  const tujengeOwner = await createUser(`client2${SEED_DOMAIN}`, "Peter Ochieng", "client");
  const mwanga = await prisma.clientBusiness.create({ data: { userId: mwangaOwner.id, name: "Mwanga Mobile" } });
  const tujenge = await prisma.clientBusiness.create({ data: { userId: tujengeOwner.id, name: "Tujenge Pesa" } });

  const grace = await createAgent({ key: "grace", name: "Grace Wanjiku", tenureDays: 550, home: { lat: -1.257, lon: 36.886 }, area: "Kariobangi North", msisdn: "0712345678" }, now);
  const faith = await createAgent({ key: "faith", name: "Faith Chebet", tenureDays: 820, home: { lat: -1.262, lon: 36.84 }, area: "Pangani", msisdn: "0722118844" }, now);
  const mercy = await createAgent({ key: "mercy", name: "Mercy Achieng", tenureDays: 400, home: { lat: -0.087, lon: 34.769 }, area: "Kondele, Kisumu", msisdn: "0733456120" }, now);
  const samuel = await createAgent({ key: "samuel", name: "Samuel Mutua", tenureDays: 400, home: { lat: -1.204, lon: 36.915 }, area: "Githurai 45", msisdn: "0745900311" }, now);
  const brian = await createAgent({ key: "brian", name: "Brian Kiprop", tenureDays: 20, home: PLACES.kawangware, area: "Kawangware", msisdn: "0798002217" }, now);
  const kevin = await createAgent({ key: "kevin", name: "Kevin Omondi", tenureDays: 60, home: { lat: -1.3, lon: 36.79 }, area: "Kibera", msisdn: "0757331904" }, now);

  const jobSpec = (clientId: string, title: string, area: string, at: Point, radius: number, payout: number, slots: number) =>
    prisma.job.create({
      data: {
        clientId, title, description: `${title}. Sign up new customers in person, scan the SIM pack where possible and attach proof of activation.`,
        areaName: area, areaLat: at.lat, areaLon: at.lon, areaRadiusM: radius, payoutPerActivationKsh: payout, commissionRate: 0.1, slots,
        createdAt: new Date(now.getTime() - 160 * DAY),
      },
    });
  const gikomba = await jobSpec(mwanga.id, "SIM registration drive, Gikomba Market", "Gikomba Market", PLACES.gikomba, 700, 300, 80);
  const trm = await jobSpec(mwanga.id, "Data bundle sign-ups, Thika Road Mall", "Thika Road Mall", PLACES.trm, 500, 250, 40);
  const kibuye = await jobSpec(tujenge.id, "Wallet activations, Kibuye Market", "Kibuye Market, Kisumu", PLACES.kibuye, 800, 350, 40);
  const githurai = await jobSpec(tujenge.id, "Wallet activations, Githurai 45 stage", "Githurai 45 stage", PLACES.githurai, 600, 280, 40);
  for (const [job, owner] of [[gikomba, mwangaOwner], [trm, mwangaOwner], [kibuye, tujengeOwner], [githurai, tujengeOwner]] as const) {
    await fundJob({ jobId: job.id, clientId: job.clientId, amountKsh: job.payoutPerActivationKsh * job.slots, actorId: owner.id });
  }

  // Histories: decided activations from 35 to 150 days ago.
  for (let i = 0; i < 18; i += 1) {
    const job = i % 3 === 0 ? trm : gikomba;
    await history({ agent: grace, job, at: nairobiTime(now, 150 - i * 6, 10 + (i % 6), 15 + (i % 4) * 10) }, "engaged", "approve");
  }
  for (let i = 0; i < 14; i += 1) {
    await history({ agent: faith, job: gikomba, at: nairobiTime(now, 140 - i * 7, 11 + (i % 5), 5 + (i % 5) * 9) }, "engaged", "approve");
  }
  for (let i = 0; i < 8; i += 1) {
    await history({ agent: mercy, job: kibuye, at: nairobiTime(now, 120 - i * 9, 9 + (i % 7), 20 + (i % 3) * 12) }, "engaged", "approve");
  }
  const mercyRefusedRisky = { activationMethod: "manual_entry" as const, proof: null };
  await history({ agent: mercy, job: kibuye, at: nairobiTime(now, 45, 16, 50), overrides: mercyRefusedRisky, device: { ipRegion: "region_a" } }, "dormant_lapsed", "refuse");
  for (let i = 0; i < 4; i += 1) {
    await history({ agent: samuel, job: githurai, at: nairobiTime(now, 110 - i * 12, 12 + (i % 4), 10 + i * 7) }, "engaged", "approve");
  }

  /** Hand-keyed, no proof, a SIM registered the day before, network region far from the GPS fix. */
  const risky = (agent: SeedAgent, job: Job, at: Date, method: "manual_entry" | "qr_scan" = "manual_entry"): SubmitSpec => ({
    agent, job, at, acceptedMinutesBefore: 3, assignedMinutesBefore: 20,
    overrides: { activationMethod: method, proof: null, simRegisteredAt: new Date(at.getTime() - 32 * HOUR) },
    device: { ipRegion: "region_c" },
  });

  // Samuel: refusals (dormant customer, a complaint, SIM lapsed), one of them contested.
  // If the model refuses at T7 the refusal is automatic; if it sends the item
  // to a reviewer instead, the seed's reviewer refuses it.
  const refuse = async (id: string, activity: Activity) => {
    if ((await closeHold(id, activity)) === "in_review") {
      await refuseActivation({ activationId: id, reviewerId: amina.id, reason: "Customer says they never signed up; the line was deactivated within the week.", at: new Date((await prisma.activation.findUniqueOrThrow({ where: { id } })).submittedAt.getTime() + 8 * DAY) });
    }
  };
  const samuelRefusedSpec = risky(samuel, githurai, beforeCutoff(now, 23), "qr_scan");
  const samuelRefused = await submit(samuelRefusedSpec);
  await refuse(samuelRefused, "dormant_complaint");
  expected.push({ label: "Samuel, refused (dispute open)", id: samuelRefused, want: "refused" });
  const samuelDisputed = await submit(risky(samuel, githurai, beforeCutoff(now, 9, 2, 50), "qr_scan"));
  await refuse(samuelDisputed, "dormant_complaint");
  if ((await prisma.activation.findUniqueOrThrow({ where: { id: samuelDisputed } })).state === "refused") {
    await contestRefusal({ agentId: samuel.id, activationId: samuelDisputed, note: "The customer was there in person; her phone was off for the week while she travelled.", at: nairobiTime(now, 0, 7, 30) });
  }
  expected.push({ label: "Samuel, contested refusal", id: samuelDisputed, want: "disputed" });

  // Mercy: the band changes between T0 (review) and T7 (auto_release).
  const bandChange = await submit(risky(mercy, kibuye, beforeCutoff(now, 24, 5)));
  await closeHold(bandChange, "engaged");
  expected.push({ label: "Mercy, band changes from T0 to T7", id: bandChange, want: "approved" });

  // The mockup case: Grace at Gikomba, 22 minutes after a submission at Thika Road Mall.
  const mockupAt = beforeCutoff(now, 8);
  await history({ agent: grace, job: trm, at: new Date(mockupAt.getTime() - 22 * MINUTE), gps: jitter(PLACES.trm, 80) }, "engaged", "approve");
  const mockup = await submit({
    ...risky(grace, gikomba, mockupAt),
    gps: jitter(PLACES.gikomba, 60), photoCount: 8, outside: { index: 6, at: PLACES.eastleigh },
  });
  await closeHold(mockup, "dormant");
  expected.push({ label: "Grace, the mockup case (T7 review)", id: mockup, want: "in_review" });

  // Brian, new agent: escalated to review at T0.
  const reusedNumber = nextCustomer();
  await history({ agent: faith, job: gikomba, at: nairobiTime(now, 40, 11, 0), overrides: { customerMsisdn: reusedNumber } }, "engaged", "approve");
  const brianSpec = risky(brian, gikomba, beforeCutoff(now, 0));
  const brianEscalated = await submit({ ...brianSpec, overrides: { ...brianSpec.overrides, customerMsisdn: reusedNumber } });
  expected.push({ label: "Brian, escalated at T0", id: brianEscalated, want: "in_review" });

  // Kevin: escalated at T0, asked for evidence, answered, back in the queue.
  const kevinNumber = nextCustomer();
  await history({ agent: grace, job: gikomba, at: nairobiTime(now, 50, 12, 30), overrides: { customerMsisdn: kevinNumber } }, "engaged", "approve");
  const kevinSpec = risky(kevin, gikomba, beforeCutoff(now, 0, 2, 90));
  const kevinReturned = await submit({ ...kevinSpec, overrides: { ...kevinSpec.overrides, customerMsisdn: kevinNumber } });

  // Could not be scored: the service is unreachable for this one submission.
  const realUrl = process.env.SCORING_SERVICE_URL;
  const realAttempts = process.env.SCORING_IMMEDIATE_ATTEMPTS;
  process.env.SCORING_SERVICE_URL = "http://127.0.0.1:9";
  process.env.SCORING_IMMEDIATE_ATTEMPTS = "2";
  const unscored = await submit({ agent: faith, job: gikomba, at: nairobiTime(now, 0, 9, 5) });
  process.env.SCORING_SERVICE_URL = realUrl;
  process.env.SCORING_IMMEDIATE_ATTEMPTS = realAttempts;
  expected.push({ label: "Faith, could not be scored at T0", id: unscored, want: "in_review" });

  // Mercy: a reviewer has asked for more evidence.
  const mercyAsked = await submit(risky(mercy, kibuye, beforeCutoff(now, 8, 2, 35), "qr_scan"));
  await closeHold(mercyAsked, "dormant_lapsed");
  expected.push({ label: "Mercy, awaiting evidence", id: mercyAsked, want: "awaiting_evidence" });

  // Currently held, waiting for hold-close.
  for (const [agent, job, daysAgo, hour] of [[grace, gikomba, 1, 11], [faith, gikomba, 2, 14], [mercy, kibuye, 4, 10], [samuel, githurai, 5, 13]] as const) {
    const id = await submit({ agent, job, at: nairobiTime(now, daysAgo, hour, 25) });
    expected.push({ label: `${agent.name}, held`, id, want: "held" });
  }

  // Withdrawn by the agent while held.
  const withdrawn = await submit({ agent: grace, job: trm, at: nairobiTime(now, 6, 12, 5) });
  await withdrawActivation({ agentId: grace.id, activationId: withdrawn, reason: "Customer decided to sign up with a family member's ID instead.", at: nairobiTime(now, 5, 9, 0) });
  expected.push({ label: "Grace, withdrawn", id: withdrawn, want: "withdrawn" });

  // Just submitted; its T0 score is queued for the scheduler.
  const queued = await submit({ agent: brian, job: gikomba, at: new Date(now.getTime() - 2 * MINUTE), queueOnly: true });
  expected.push({ label: "Brian, submitted (T0 queued)", id: queued, want: "submitted" });

  // Reviewer actions that need the items above.
  if ((await prisma.activation.findUniqueOrThrow({ where: { id: mercyAsked } })).state === "in_review") {
    await requestEvidence({ activationId: mercyAsked, reviewerId: amina.id, reason: "Please send a clear photo of the customer's SIM pack showing the serial number, and the signed registration form.", at: nairobiTime(now, 1, 10, 30) });
  }
  if ((await prisma.activation.findUniqueOrThrow({ where: { id: kevinReturned } })).state === "in_review") {
    await requestEvidence({ activationId: kevinReturned, reviewerId: amina.id, reason: "No proof of activation is attached. Send a photo of the activation confirmation SMS.", at: nairobiTime(now, 1, 9, 40) });
    await respondToEvidenceRequest({
      agentId: kevin.id, activationId: kevinReturned, note: "Photo of the confirmation SMS on the customer's phone attached.",
      photos: photos(1, PLACES.gikomba, nairobiTime(now, 0, 8, 0), 0), at: nairobiTime(now, 0, 8, 5),
    });
  }
  expected.push({ label: "Kevin, evidence returned", id: kevinReturned, want: "in_review" });

  // Historical notifications are already read; only the live ones stay unread.
  await prisma.notification.updateMany({
    where: {
      kind: { notIn: ["evidence_returned", "dispute"] },
      NOT: { activationId: mercyAsked, kind: "evidence_requested" },
    },
    data: { readAt: now },
  });
  await report(expected);
}

async function report(expected: Array<{ label: string; id: string; want: ActivationState }>): Promise<void> {
  const counts = await prisma.activation.groupBy({ by: ["state"], _count: { _all: true } });
  console.log("\nActivations by state:");
  for (const row of counts) console.log(`  ${row.state.padEnd(18)} ${row._count._all}`);
  console.log("\nNamed cases (state as decided by the real scoring service):");
  let misses = 0;
  for (const item of expected) {
    const activation = await prisma.activation.findUniqueOrThrow({ where: { id: item.id }, include: { decisions: { orderBy: { recordedAt: "asc" } } } });
    const bands = activation.decisions.map((d) => `${d.mode}:${d.band}(${d.probability.toFixed(3)})`).join(" -> ") || "no score";
    const ok = activation.state === item.want;
    if (!ok) misses += 1;
    console.log(`  ${ok ? "ok  " : "MISS"} ${activation.reference} ${item.label}: ${activation.state} [${bands}]`);
  }
  console.log(misses === 0 ? "\nEvery named case landed where intended." : `\n${misses} case(s) landed elsewhere; the model decided differently. See above.`);
  console.log(`\nSign in with any @ledgerfield.test account; the password is ${PASSWORD}.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
