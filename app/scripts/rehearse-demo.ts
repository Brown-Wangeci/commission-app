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
import { acceptAndSubmit, call, DAY, DEMO_EVIDENCE_FIELDS, nairobiDate, signIn, week, type Json, type Session } from "./demo-client";
import { loadEnv } from "./load-env";
import { placeholderPng } from "../prisma/seed-support/placeholder-png";
import { formatCents } from "../src/lib/money/cents";

loadEnv();

function step(text: string): void {
  console.log(`\n== ${text}`);
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

type EscrowView = {
  availableCents: number;
  availableDerivation: string;
  jobs: Array<{ job: { id: string }; terms: { commission: { amountCents: number; derivation: string }; liability: { amountCents: number; derivation: string } } }>;
};

async function postJobAndFund(client: Session): Promise<string> {
  step("1. Client (client2@) publishes a job from its funded escrow, locking its maximum liability");
  // KSh 2,500.00 x 12.00% + KSh 50.00 flat = KSh 350.00 per approved submission; 2 slots lock KSh 700.00.
  // The seed funds this client. Real funding needs an M-Pesa prompt, so it is not rehearsed here.
  const { jobId } = await call<{ jobId: string }>(client, "POST", "/api/client/jobs", {
    title: "Demo: wallet activations, Kibuye Market", description: "Sign up new wallet customers in person at the market.",
    areaName: "Kibuye Market, Kisumu", areaLat: -0.0995, areaLon: 34.768, areaRadiusM: 800,
    submissionValueCents: 250_000, commissionRateBps: 1200, flatCommissionCents: 5_000, slots: 2,
    deadline: nairobiDate(new Date(Date.now() + 30 * DAY)), evidenceFields: DEMO_EVIDENCE_FIELDS,
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
  step("3. Agent (mercy@) accepts and submits an activation; it is scored at T0");
  const submitted = await acceptAndSubmit(agent, assignmentId, "dev-mercy-6120");
  console.log(`   ${submitted.reference} submitted; state now ${submitted.state}`);
  const id = submitted.activationId;
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
