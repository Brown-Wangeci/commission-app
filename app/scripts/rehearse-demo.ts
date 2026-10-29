/**
 * Rehearses the demonstration path in DEMO.md against a running app and a
 * running scoring service, through the app's own HTTP API, signed in as each
 * role in turn. It never touches the database directly.
 *
 * Prerequisites: PostgreSQL, the scoring service, the app (`npm run dev` or
 * `npm start`) and seed data (`npm run db:seed`).
 *
 * Usage: npm run demo:rehearse            (app at http://localhost:3000)
 *        APP_URL=http://host:port npm run demo:rehearse
 */
import { loadEnv } from "./load-env";
import { placeholderPng } from "../prisma/seed-support/placeholder-png";
import { formatCents } from "../src/lib/money/cents";

loadEnv();

const APP = process.env.APP_URL ?? "http://localhost:3000";
const PASSWORD = "ledgerfield-demo";
const DAY = 24 * 60 * 60 * 1000;

type Session = { email: string; cookie: string };
type Json = Record<string, unknown>;

function step(text: string): void {
  console.log(`\n== ${text}`);
}

function cookiesFrom(response: Response): string[] {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]);
}

async function signIn(email: string): Promise<Session> {
  const csrf = await fetch(`${APP}/api/auth/csrf`);
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  const response = await fetch(`${APP}/api/auth/callback/credentials`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: cookiesFrom(csrf).join("; ") },
    body: new URLSearchParams({ csrfToken, email, password: PASSWORD, json: "true" }),
  });
  const session = cookiesFrom(response).find((cookie) => cookie.includes("session-token="));
  if (!session) throw new Error(`Could not sign in as ${email} (HTTP ${response.status}).`);
  return { email, cookie: session };
}

async function call<T = Json>(session: Session, method: string, path: string, body?: Json | FormData): Promise<T> {
  const isForm = body instanceof FormData;
  const response = await fetch(`${APP}${path}`, {
    method,
    headers: { cookie: session.cookie, ...(body && !isForm ? { "Content-Type": "application/json" } : {}) },
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} as ${session.email}: HTTP ${response.status} ${text}`);
  return JSON.parse(text) as T;
}

function nairobiDate(date: Date): string {
  return new Date(date.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

type Decision = { mode: string; band: string; probability: number; releaseThreshold: number; rejectThreshold: number };
type Detail = {
  state: string;
  reference: string;
  decisions: Decision[];
  payout: { authorisation: Json | null; amount: { amountCents: number; basis: string; commission: { derivation: string } } | null };
};

function paid(detail: Detail): string {
  if (!detail.payout.authorisation || !detail.payout.amount) return "no";
  return `yes, ${formatCents(detail.payout.amount.amountCents)} (${detail.payout.amount.commission.derivation}; ${detail.payout.amount.basis})`;
}

function describe(decision: Decision): string {
  return `${decision.mode.toUpperCase()} ${decision.band} at ${(decision.probability * 100).toFixed(1)}% (cut-offs ${(decision.releaseThreshold * 100).toFixed(1)}% / ${(decision.rejectThreshold * 100).toFixed(1)}%)`;
}

function week(kind: "engaged" | "dormant_lapsed"): Json[] {
  return Array.from({ length: 8 }, (_, day) => {
    const active = kind === "engaged";
    return {
      day, customerActive: active, transactionCount: active ? 3 : 0, topupCents: active ? 10_000 : 0, usageMinutes: active ? 25 : 0,
      supportContact: false, complaintOrRefund: false, simActive: kind === "engaged" || day < 4,
    };
  });
}

type EscrowView = {
  availableCents: number;
  availableDerivation: string;
  jobs: Array<{ job: { id: string }; terms: { commission: { amountCents: number; derivation: string }; liability: { amountCents: number; derivation: string } } }>;
};

async function postJobAndFund(client: Session): Promise<string> {
  step("1. Client (client2@) deposits into escrow and publishes a job, locking its maximum liability");
  await call(client, "POST", "/api/client/escrow/fund", { amountCents: 35_000 });
  // KSh 2,500.00 x 12.00% + KSh 50.00 flat = KSh 350.00 per approved submission; 2 slots lock KSh 700.00.
  // The second half of the lock is deposited with the job itself.
  const { jobId } = await call<{ jobId: string }>(client, "POST", "/api/client/jobs", {
    title: "Demo: wallet activations, Kibuye Market", description: "Sign up new wallet customers in person at the market.",
    areaName: "Kibuye Market, Kisumu", areaLat: -0.0995, areaLon: 34.768, areaRadiusM: 800,
    submissionValueCents: 250_000, commissionRateBps: 1200, flatCommissionCents: 5_000, slots: 2, initialDepositCents: 35_000,
  });
  const escrow = await call<EscrowView>(client, "GET", "/api/client/escrow");
  const terms = escrow.jobs.find((row) => row.job.id === jobId)!.terms;
  console.log(`   job ${jobId}: ${formatCents(terms.commission.amountCents)} per approved submission (${terms.commission.derivation})`);
  console.log(`   locked ${formatCents(terms.liability.amountCents)} (${terms.liability.derivation}); available ${formatCents(escrow.availableCents)} (${escrow.availableDerivation})`);
  return jobId;
}

async function assignToMercy(admin: Session, jobId: string): Promise<string> {
  step("2. Reviewer (reviewer@) assigns the job to Mercy Achieng; one commission is reserved from the job's lock");
  const { agents } = await call<{ agents: Array<{ id: string; email: string }> }>(admin, "GET", "/api/admin/agents");
  const mercy = agents.find((agent) => agent.email === "mercy@ledgerfield.test");
  if (!mercy) throw new Error("Seed agent mercy@ledgerfield.test not found. Run npm run db:seed.");
  const { assignmentId, holdCents } = await call<{ assignmentId: string; holdCents: number }>(admin, "POST", `/api/admin/jobs/${jobId}/assign`, { agentId: mercy.id });
  console.log(`   assignment ${assignmentId}, ${formatCents(holdCents)} held`);
  return assignmentId;
}

async function acceptAndSubmit(agent: Session, assignmentId: string): Promise<string> {
  step("3. Agent (mercy@) accepts and submits an activation; it is scored at T0");
  await call(agent, "POST", `/api/agent/assignments/${assignmentId}/accept`);
  const form = new FormData();
  const fields: Record<string, string> = {
    assignmentId, customerMsisdn: `07${String(Date.now()).slice(-8)}`, simRegisteredAt: nairobiDate(new Date(Date.now() - DAY)),
    activationMethod: "qr_scan", gpsLat: "-0.0991", gpsLon: "34.7684", gpsAccuracyM: "9",
    deviceId: "dev-mercy-6120", deviceOs: "android", appVersion: "web-0.1.0", networkType: "cellular", ipRegion: "region_c",
    agentNote: "Customer registered at her stall; no proof screenshot, her phone battery was flat.",
  };
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const meta = [];
  for (let i = 0; i < 3; i += 1) {
    form.append("photos", new File([placeholderPng(900 + i)], `demo-${i + 1}.png`, { type: "image/png" }));
    meta.push({ capturedAt: new Date(Date.now() - (10 - i) * 60_000).toISOString(), gpsLat: -0.0992, gpsLon: 34.7683, gpsAccuracyM: 8, locationSource: "device" });
  }
  form.set("photoMeta", JSON.stringify(meta));
  const result = await call<{ activationId: string; reference: string; state: string }>(agent, "POST", "/api/agent/activations", form);
  console.log(`   ${result.reference} submitted; state now ${result.state}`);
  return result.activationId;
}

async function detail(admin: Session, id: string): Promise<Detail> {
  return call<Detail>(admin, "GET", `/api/admin/review/${id}`);
}

async function closeHold(client: Session, admin: Session, id: string, t0: Decision): Promise<Detail> {
  const kind = t0.band === "auto_release" ? "dormant_lapsed" : "engaged";
  step(`4. Client reports the customer's first week (${kind === "engaged" ? "active every day" : "never active, SIM off from day 4"})`);
  console.log(`   chosen because T0 was ${t0.band}: this week should move the hold-close band the other way`);
  await call(client, "POST", `/api/client/activations/${id}/activity`, { days: week(kind) });
  step("5. Reviewer forces the hold-close (T7) score instead of waiting seven days");
  const forced = await call<{ outcome: string; state: string }>(admin, "POST", `/api/admin/activations/${id}/score-t7`);
  console.log(`   T7 run: ${forced.outcome}; state now ${forced.state}`);
  return detail(admin, id);
}

async function finalDecision(admin: Session, id: string, current: Detail): Promise<Detail> {
  if (current.state === "in_review" || current.state === "disputed") {
    step("6. Reviewer opens the review screen and approves with a reason");
    await call(admin, "POST", `/api/admin/review/${id}/approve`, { reason: "Called the customer: she confirmed the sign-up and uses the wallet at her stall." });
  } else {
    step(`6. No reviewer needed: the hold-close model decided (${current.state})`);
  }
  return detail(admin, id);
}

async function evidencePath(admin: Session): Promise<void> {
  step("7. Awaiting evidence, on the seeded mockup-like case");
  const { items } = await call<{ items: Array<{ id: string; reference: string; agentName: string }> }>(admin, "GET", "/api/admin/review?tab=waiting");
  const target = items.find((item) => item.agentName === "Grace Wanjiku");
  if (!target) throw new Error("Grace Wanjiku's seeded submission is not in the queue. Re-run npm run db:seed.");
  await call(admin, "POST", `/api/admin/review/${target.id}/request-evidence`, { reason: "No proof of activation is attached. Send a photo of the activation confirmation SMS." });
  console.log(`   ${target.reference}: evidence requested -> ${(await detail(admin, target.id)).state}`);
  const grace = await signIn("grace@ledgerfield.test");
  const form = new FormData();
  form.set("note", "Confirmation SMS photographed on the customer's phone.");
  form.append("photos", new File([placeholderPng(950)], "confirmation.png", { type: "image/png" }));
  form.set("photoMeta", JSON.stringify([{ capturedAt: new Date().toISOString(), gpsLat: -1.2836, gpsLon: 36.834, gpsAccuracyM: 7, locationSource: "device" }]));
  await call(grace, "POST", `/api/agent/activations/${target.id}/evidence`, form);
  console.log(`   Grace responded -> ${(await detail(admin, target.id)).state}`);
  await call(admin, "POST", `/api/admin/review/${target.id}/approve`, { reason: "Confirmation SMS matches the customer and the date." });
  const after = await detail(admin, target.id);
  console.log(`   reviewer approved -> ${after.state}; payout authorised: ${paid(after)}`);
}

async function main(): Promise<void> {
  const client = await signIn("client2@ledgerfield.test");
  const admin = await signIn("reviewer@ledgerfield.test");
  const agent = await signIn("mercy@ledgerfield.test");
  const jobId = await postJobAndFund(client);
  const assignmentId = await assignToMercy(admin, jobId);
  const id = await acceptAndSubmit(agent, assignmentId);
  const t0 = (await detail(admin, id)).decisions[0];
  if (!t0) throw new Error("No T0 score was recorded; is the scoring service running?");
  console.log(`   ${describe(t0)}`);
  const afterT7 = await closeHold(client, admin, id, t0);
  const t7 = afterT7.decisions.find((d) => d.mode === "t7");
  if (t7) console.log(`   ${describe(t7)}`);
  const final = await finalDecision(admin, id, afterT7);
  console.log(`   final state: ${final.state}; payout authorised: ${paid(final)}`);
  console.log(`   band changed between T0 and T7: ${t7 && t7.band !== t0.band ? "yes" : "no"}`);
  await evidencePath(admin);
  console.log("\nRehearsal complete.");
}

main().catch((error) => {
  console.error(`\nRehearsal failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
