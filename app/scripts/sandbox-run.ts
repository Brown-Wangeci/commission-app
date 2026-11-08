/**
 * The real sandbox run behind FR-06, FR-19 and IR-01: section F of Build 3.
 *
 * Drives the running app through its own HTTP API against the live Daraja
 * sandbox: STK Push, callback, credit, job, submission, approval, B2C, result.
 * Nothing here is mocked. It starts from a client with a zero balance, so the
 * money behind the job can only have come from the STK callback. Every
 * exchange is written, redacted, by the code that makes it, when
 * MPESA_CAPTURE_DIR is set; this script adds run-summary.json beside them.
 *
 * Refuses anything but the sandbox.
 *
 * With --b2c-leg it funds the client by a SIMULATED callback and runs the real
 * B2C leg alone, for when no phone is at hand to enter a PIN. That is not the
 * end-to-end run: run-summary.json says so, and its captures belong in their
 * own folder.
 *
 * Prerequisites: PostgreSQL, the scoring service, a public tunnel in
 * MPESA_CALLBACK_BASE_URL, and the app started with MPESA_CAPTURE_DIR set.
 *
 * Usage: MPESA_CAPTURE_DIR=<dir> npm run sandbox:run
 *   MPESA_SANDBOX_PAYER_MSISDN   the phone prompted. A real Safaricom line is
 *                                needed for a success: Daraja's test number has
 *                                no handset, so it ends in 1037, no response.
 *   MPESA_SANDBOX_PAYOUT_MSISDN  the agent's payout number
 */
import fs from "node:fs";
import path from "node:path";
import { normaliseMsisdn } from "@/lib/validation";
import { acceptAndSubmit, call, DAY, DEMO_EVIDENCE_FIELDS, nairobiDate, PASSWORD, signIn, week, type Session } from "./demo-client";
import { loadEnv } from "./load-env";

loadEnv();

const TEST_MSISDN = "0708374149";
/**
 * Every real amount in this script is exactly KSh 10.00: the smallest value
 * that is both within a KSh 1-10 instruction and at least Daraja's documented
 * B2C minimum (KSh 10). Value KSh 10.00 at 100% commissions KSh 10.00; one
 * slot locks exactly what is funded.
 */
const SUBMISSION_VALUE_CENTS = 1_000;
const COMMISSION_BPS = 10_000;
const COMMISSION_CENTS = 1_000;
const WAIT_MS = 240_000;
const POLL_MS = 3_000;

const CLIENT = "sandbox-client@ledgerfield.test";
const REVIEWER = "sandbox-reviewer@ledgerfield.test";
const AGENT = "sandbox-agent@ledgerfield.test";

type Step = { at: string; step: string; detail: string };
const steps: Step[] = [];
const b2cLegOnly = process.argv.includes("--b2c-leg");

function record(step: string, detail: string): void {
  steps.push({ at: new Date().toISOString(), step, detail });
  console.log(`\n== ${step}\n   ${detail}`);
}

async function until<T>(what: string, read: () => Promise<T | null>, tick: () => Promise<unknown> = async () => undefined): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    await tick();
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

async function main(): Promise<void> {
  const { config } = await import("../src/lib/config");
  const { missingCredentials } = await import("../src/lib/payments/credentials");
  const { prisma } = await import("../src/lib/db");
  const { hashPassword } = await import("../src/lib/auth/password");
  const { runDuePayments } = await import("../src/lib/payments/worker");
  const { formatCents } = await import("../src/lib/money/cents");
  const { maskPhone } = await import("../src/lib/payments/redact");

  const settings = config();
  if (settings.MPESA_ENV !== "sandbox" || settings.MPESA_BASE_URL) throw new Error("This script runs only against the real Daraja sandbox.");
  const missing = missingCredentials();
  if (missing.length > 0) throw new Error(`Not set: ${missing.join(", ")}.`);
  const captureDir = settings.MPESA_CAPTURE_DIR;
  if (!captureDir) throw new Error("Set MPESA_CAPTURE_DIR, here and on the running app, or nothing is captured.");
  const payer = process.env.MPESA_SANDBOX_PAYER_MSISDN ?? TEST_MSISDN;
  // Stored in the local 0-prefixed form the rest of the app and toDarajaMsisdn expect.
  const payout = normaliseMsisdn(process.env.MPESA_SANDBOX_PAYOUT_MSISDN ?? TEST_MSISDN);

  async function user(email: string, name: string, role: "admin" | "agent" | "client") {
    const passwordHash = await hashPassword(PASSWORD);
    return prisma.user.upsert({ where: { email }, update: {}, create: { email, name, role, passwordHash } });
  }

  async function freshClient() {
    const owner = await user(CLIENT, "Sandbox Client", "client");
    return prisma.clientBusiness.upsert({ where: { userId: owner.id }, update: {}, create: { userId: owner.id, name: "Sandbox Client" } });
  }

  async function freshAgent() {
    const agentUser = await user(AGENT, "Sandbox Agent", "agent");
    return prisma.agent.upsert({
      where: { userId: agentUser.id },
      update: { payoutMsisdn: payout },
      create: { userId: agentUser.id, payoutMsisdn: payout, registeredAt: new Date(Date.now() - 200 * DAY), homeLat: -0.0991, homeLon: 34.7684, homeAreaName: "Kisumu" },
    });
  }

  const client = await freshClient();
  const agentRow = await freshAgent();
  await user(REVIEWER, "Sandbox Reviewer", "admin");
  const clientSession = await signIn(CLIENT);
  const reviewer = await signIn(REVIEWER);
  const agent = await signIn(AGENT);

  async function available(session: Session): Promise<number> {
    return (await call<{ availableCents: number }>(session, "GET", "/api/client/escrow")).availableCents;
  }

  const before = await available(clientSession);
  record("0. Starting balance", `${formatCents(before)} available to the client.`);

  async function realFunding(): Promise<void> {
    const started = await call<{ attemptId: string; status: string; failureReason: string | null }>(clientSession, "POST", "/api/client/escrow/fund", { amountCents: COMMISSION_CENTS, payerMsisdn: payer });
    record("1. STK Push initiated", `${formatCents(COMMISSION_CENTS)} to ${maskPhone(payer)}. Attempt status ${started.status}.${started.failureReason ? ` ${started.failureReason}` : ""}`);
    const notCredited = await available(clientSession);
    record("1a. Balance straight after the request", `${formatCents(notCredited)}: the initiating request credits nothing.`);
    const settled = await until("the STK callback", async () => {
      const attempt = await prisma.fundingAttempt.findUniqueOrThrow({ where: { id: started.attemptId } });
      return attempt.status === "confirmed" || attempt.status === "failed" ? attempt : null;
    });
    record("2. Callback received", `Attempt ${settled.status}. Result code ${settled.resultCode ?? "none"}. Receipt ${settled.receipt ?? "none"}.${settled.failureReason ? ` ${settled.failureReason}` : ""}`);
    if (settled.status !== "confirmed") throw new Error("Funding did not succeed, so the run stops here. The failure is captured.");
  }

  async function simulatedFunding(): Promise<void> {
    const { simulateConfirmedFunding } = await import("../prisma/seed-support/simulated-payments");
    await simulateConfirmedFunding({ clientId: client.id, amountCents: COMMISSION_CENTS, actorId: client.userId });
    record("1-2. Funding SIMULATED", "No STK Push was sent. This run proves the B2C leg only, not funding.");
  }

  await (b2cLegOnly ? simulatedFunding() : realFunding());
  const credited = await available(clientSession);
  record("3. Balance credited", `${formatCents(credited)} available.`);

  const { jobId } = await call<{ jobId: string }>(clientSession, "POST", "/api/client/jobs", {
    title: "Sandbox run: wallet activation, Kibuye Market", description: "One in-person wallet activation for the recorded sandbox run.",
    areaName: "Kibuye Market, Kisumu", areaLat: -0.0995, areaLon: 34.768, areaRadiusM: 800,
    submissionValueCents: SUBMISSION_VALUE_CENTS, commissionRateBps: COMMISSION_BPS, flatCommissionCents: 0, slots: 1,
    deadline: nairobiDate(new Date(Date.now() + 30 * DAY)), evidenceFields: DEMO_EVIDENCE_FIELDS,
  });
  const { assignmentId } = await call<{ assignmentId: string }>(reviewer, "POST", `/api/admin/jobs/${jobId}/assign`, { agentId: agentRow.id });
  const submitted = await acceptAndSubmit(agent, assignmentId, "dev-sandbox-run");
  record("4. Submission", `${submitted.reference} submitted and scored at T0. State ${submitted.state}.`);

  const id = submitted.activationId;
  if (submitted.state !== "in_review") {
    await call(clientSession, "POST", `/api/client/activations/${id}/activity`, { days: week("engaged") });
    const forced = await call<{ outcome: string; state: string }>(reviewer, "POST", `/api/admin/activations/${id}/score-t7`);
    record("4a. Hold-close score", `Forced instead of waiting seven days: ${forced.outcome}. State ${forced.state}.`);
  }
  const state = (await prisma.activation.findUniqueOrThrow({ where: { id } })).state;
  if (state === "in_review") await call(reviewer, "POST", `/api/admin/review/${id}/approve`, { reason: "Recorded sandbox run: evidence reviewed." });
  const decided = await prisma.activation.findUniqueOrThrow({ where: { id } });
  record("5. Submission approved", `State ${decided.state}${state === "in_review" ? ", by a reviewer" : ", by the hold-close decision"}.`);
  if (decided.state !== "approved") throw new Error(`The activation ended ${decided.state}, so nothing is paid.`);

  const queued = await prisma.disbursement.findUniqueOrThrow({ where: { activationId: id } });
  const commission = await prisma.commission.findUniqueOrThrow({ where: { activationId: id } });
  record("6. B2C queued", `${formatCents(queued.amountCents)} to ${maskPhone(queued.payoutMsisdn)}, from stored commission ${commission.id}. Status ${queued.status}.`);

  const paid = await until("the B2C result", async () => {
    const row = await prisma.disbursement.findUniqueOrThrow({ where: { id: queued.id } });
    return row.status === "paid" || row.status === "failed" ? row : null;
  }, () => runDuePayments(new Date()));
  record("7. B2C result received", `Status ${paid.status}. Result code ${paid.resultCode ?? "none"}. Receipt ${paid.receipt ?? "none"}.${paid.failureReason ? ` ${paid.failureReason}` : ""}`);
  if (paid.status !== "paid") throw new Error("The payout did not complete, so the run stops here. The failure is captured.");
}

function writeSummary(result: string): void {
  const dir = process.env.MPESA_CAPTURE_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const scope = b2cLegOnly ? "B2C leg only: funding was simulated, so this is not the end-to-end run" : "end to end, nothing simulated";
  const summary = { environment: "Daraja sandbox", scope, result, steps };
  fs.writeFileSync(path.join(dir, "run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
}

main()
  .then(() => {
    writeSummary("completed");
    console.log("\nSandbox run complete.");
    process.exit(0);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    writeSummary(`stopped: ${message}`);
    console.error(`\nSandbox run stopped: ${message}`);
    process.exit(1);
  });
