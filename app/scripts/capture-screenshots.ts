/**
 * Section F: captures the Chapter 5 screenshots with Playwright against a
 * running app on a freshly seeded database. Every figure has a fixed file
 * name, figure-5-01 to figure-5-16, so a rerun always overwrites the same
 * files; docs/chapter5/evidence/screenshots/captions.md carries one factual
 * caption per figure, written by hand after reviewing the output.
 *
 * The named cases are looked up by their real characteristics (state and
 * agent), not by reference number, so a change in the seed cannot silently
 * point a figure at the wrong case.
 *
 * Figures 15 and 16 need an accepted but unsubmitted assignment, which the
 * seed never leaves. The script makes one the way a real user would: the
 * client posts a job and an administrator assigns it to Mercy through the
 * app's API, then Mercy signs in on the login page and presses "Accept job"
 * in the browser. Nothing is submitted.
 *
 * Usage: npx tsx scripts/capture-screenshots.ts [out_dir]
 * Prerequisites: the app running (npm start) against a freshly seeded
 * database, at APP_URL (default http://localhost:3000).
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { APP, call, DAY, DEMO_EVIDENCE_FIELDS, nairobiDate, PASSWORD, signIn } from "./demo-client";
import { loadEnv } from "./load-env";

loadEnv();

const VIEWPORT = { width: 1360, height: 900 };
const PHONE = { width: 360, height: 800 };
const AGENT_EMAIL = "mercy@ledgerfield.test";
const skipped: string[] = [];
let captured = 0;

async function contextFor(browser: Browser, email: string): Promise<BrowserContext> {
  const session = await signIn(email);
  const context = await browser.newContext({ viewport: VIEWPORT });
  const url = new URL(APP);
  const eq = session.cookie.indexOf("=");
  const name = session.cookie.slice(0, eq);
  const value = decodeURIComponent(session.cookie.slice(eq + 1));
  await context.addCookies([{ name, value, domain: url.hostname, path: "/", httpOnly: true }]);
  return context;
}

async function save(page: Page, outDir: string, name: string, note: string): Promise<void> {
  // A click (such as Verify) can leave the page scrolled; the sticky top bar
  // would then be drawn mid-page in a full-page capture.
  await page.evaluate("window.scrollTo(0, 0)");
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true });
  captured += 1;
  console.log(`  ok    ${name}  <-  ${note}`);
}

async function shot(page: Page, outDir: string, name: string, path_: string, wait?: string): Promise<void> {
  try {
    await page.goto(`${APP}${path_}`, { waitUntil: "networkidle", timeout: 20_000 });
    if (wait) await page.waitForSelector(wait, { timeout: 10_000 }).catch(() => undefined);
    await save(page, outDir, name, path_);
  } catch (error) {
    skipped.push(`${name} (${path_}): ${error instanceof Error ? error.message : String(error)}`);
    console.log(`  SKIP  ${name}  <-  ${path_}: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
  }
}

async function findByState(prisma: any, state: string, agentNameContains?: string): Promise<string | null> {
  const where: Record<string, unknown> = { state };
  if (agentNameContains) where.agent = { user: { name: { contains: agentNameContains } } };
  const row = await prisma.activation.findFirst({ where, select: { id: true }, orderBy: { submittedAt: "asc" } });
  return row?.id ?? null;
}

/** A small job from client2, assigned to Mercy and not yet accepted. Returns the assignment id. */
async function unacceptedAssignment(): Promise<string> {
  const admin = await signIn("reviewer@ledgerfield.test");
  const client = await signIn("client2@ledgerfield.test");
  const { jobId } = await call<{ jobId: string }>(client, "POST", "/api/client/jobs", {
    title: "Wallet activations, Kibuye Market (screenshot job)",
    description: "Sign up new wallet customers in person at the market.",
    areaName: "Kibuye Market, Kisumu", areaLat: -0.0995, areaLon: 34.768, areaRadiusM: 800,
    submissionValueCents: 10_000, commissionRateBps: 1000, flatCommissionCents: 0, slots: 1,
    deadline: nairobiDate(new Date(Date.now() + 30 * DAY)), evidenceFields: DEMO_EVIDENCE_FIELDS,
  });
  const { agents } = await call<{ agents: Array<{ id: string; email: string }> }>(admin, "GET", "/api/admin/agents");
  const mercy = agents.find((agent) => agent.email === AGENT_EMAIL);
  if (!mercy) throw new Error(`${AGENT_EMAIL} not found; seed the database first.`);
  const { assignmentId } = await call<{ assignmentId: string }>(admin, "POST", `/api/admin/jobs/${jobId}/assign`, { agentId: mercy.id });
  return assignmentId;
}

/** Figures 15 and 16: sign in and accept through the UI, then the form at desktop and phone width. */
async function submissionForm(browser: Browser, outDir: string): Promise<void> {
  const assignmentId = await unacceptedAssignment();
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  try {
    await page.goto(`${APP}/login`, { waitUntil: "networkidle" });
    await page.getByLabel("Email").fill(AGENT_EMAIL);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: /Sign in/i }).click();
    await page.waitForURL(`${APP}/agent`, { timeout: 15_000 });
    await page.getByRole("button", { name: "Accept job" }).first().click();
    await page.getByRole("link", { name: "Submit activation" }).first().waitFor({ timeout: 15_000 });
    await page.goto(`${APP}/agent/submit/${assignmentId}`, { waitUntil: "networkidle" });
    await page.waitForSelector("form", { timeout: 10_000 });
    await save(page, outDir, "figure-5-15-agent-submission-form", `/agent/submit/${assignmentId} (accepted in the UI)`);
    await page.setViewportSize(PHONE);
    await page.waitForTimeout(300);
    await save(page, outDir, "figure-5-16-agent-submission-form-mobile", `same form at ${PHONE.width} px wide`);
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  const outDir = process.argv[2] ?? "../docs/chapter5/evidence/screenshots";
  fs.mkdirSync(outDir, { recursive: true });

  const { prisma } = await import("../src/lib/db");
  const disputedId = (await findByState(prisma, "disputed", "Samuel")) ?? (await findByState(prisma, "disputed"));
  const inReviewMockup = (await findByState(prisma, "in_review", "Grace")) ?? (await findByState(prisma, "in_review"));
  const scoringFailedIds: string[] = (
    await prisma.auditEvent.findMany({ where: { kind: "scoring_failed", activationId: { not: null } }, select: { activationId: true }, distinct: ["activationId"] })
  ).map((e: { activationId: string | null }) => e.activationId as string);
  const couldNotBeScored = scoringFailedIds.length
    ? await prisma.activation.findFirst({ where: { id: { in: scoringFailedIds }, decisions: { none: {} } }, select: { id: true }, orderBy: { submittedAt: "asc" } }).catch(() => null)
    : null;
  const awaitingEvidence = await findByState(prisma, "awaiting_evidence");
  const clientJob = await prisma.job.findFirst({ where: { client: { user: { email: "client2@ledgerfield.test" } } }, select: { id: true }, orderBy: { createdAt: "asc" } });
  console.log({ disputedId, inReviewMockup, couldNotBeScored: couldNotBeScored?.id, awaitingEvidence, clientJob: clientJob?.id });

  const browser = await chromium.launch();
  try {
    const agentCtx = await contextFor(browser, AGENT_EMAIL);
    const adminCtx = await contextFor(browser, "reviewer@ledgerfield.test");
    const clientCtx = await contextFor(browser, "client2@ledgerfield.test");
    const agent = await agentCtx.newPage();
    const admin = await adminCtx.newPage();
    const client = await clientCtx.newPage();

    await shot(agent, outDir, "figure-5-01-agent-status-list", "/agent/activations", "main");
    await shot(admin, outDir, "figure-5-02-admin-review-queue", "/admin/review", "table, .empty");
    if (inReviewMockup) await shot(admin, outDir, "figure-5-03-admin-review-mockup-case", `/admin/review/${inReviewMockup}`, "#decide");
    else skipped.push("figure-5-03: no in_review activation in seed data");
    if (awaitingEvidence) await shot(admin, outDir, "figure-5-04-awaiting-evidence", `/admin/review/${awaitingEvidence}`, "#decide");
    else skipped.push("figure-5-04: no awaiting_evidence activation in seed data");
    if (couldNotBeScored) await shot(admin, outDir, "figure-5-05-could-not-be-scored", `/admin/review/${couldNotBeScored.id}`, "#decide");
    else skipped.push("figure-5-05: no activation with a scoring_failed audit event and no decision in seed data");
    await shot(client, outDir, "figure-5-06-client-escrow-and-jobs", "/client", "table, .empty");
    if (clientJob) await shot(client, outDir, "figure-5-07-client-job-detail", `/client/jobs/${clientJob.id}`, "table, .empty");
    else skipped.push("figure-5-07: client2 has no job in seed data");
    await shot(admin, outDir, "figure-5-08-payouts-with-failure", "/admin/payouts", "table, .empty");
    await shot(admin, outDir, "figure-5-09-audit-log-with-anchoring", "/admin/audit", "table");

    if (disputedId) {
      await admin.goto(`${APP}/admin/review/${disputedId}`, { waitUntil: "networkidle" });
      const verifyButton = admin.getByRole("button", { name: /Verify against the blockchain/i });
      if (await verifyButton.count()) {
        await verifyButton.click();
        await admin.waitForTimeout(1500);
      }
      await save(admin, outDir, "figure-5-10-dispute-verification-result", `/admin/review/${disputedId} (after Verify)`);
    } else {
      skipped.push("figure-5-10: no disputed activation in seed data");
    }

    const anonContext = await browser.newContext({ viewport: VIEWPORT });
    const anon = await anonContext.newPage();
    await anon.goto(`${APP}/signup`, { waitUntil: "networkidle" });
    await anon.getByLabel("A client business").check();
    await anon.getByLabel("Your full name").fill("Test Duplicate");
    await anon.getByLabel("Email").fill("client2@ledgerfield.test");
    await anon.getByLabel("Password").fill(PASSWORD);
    await anon.getByLabel("Business name").fill("Test Co");
    await anon.getByRole("button", { name: /Create account/i }).click();
    await anon.waitForSelector(".alert.error, .field-error", { timeout: 10_000 }).catch(() => undefined);
    await save(anon, outDir, "figure-5-11-validation-signup-duplicate-email", "/signup (submitted with an email already registered)");
    await anonContext.close();

    await client.goto(`${APP}/client/jobs/new`, { waitUntil: "networkidle" });
    const publishButton = client.getByRole("button", { name: /Publish/i });
    if (await publishButton.count()) {
      await publishButton.click().catch(() => undefined);
      await client.waitForTimeout(500);
    }
    await save(client, outDir, "figure-5-12-validation-empty-job-form", "/client/jobs/new (submitted empty)");

    await admin.goto(`${APP}/admin/review/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`, { waitUntil: "networkidle" }).catch(() => undefined);
    await save(admin, outDir, "figure-5-13-validation-not-found", "a non-existent activation id");

    const forbidden = await client.request.get(`${APP}/api/admin/review`).catch(() => null);
    await client.goto(`${APP}/client`, { waitUntil: "networkidle" });
    await save(client, outDir, "figure-5-14-validation-forbidden-role", `client session; /api/admin/review returned HTTP ${forbidden?.status()}`);

    await agentCtx.close();
    await adminCtx.close();
    await clientCtx.close();

    await submissionForm(browser, outDir);
  } finally {
    await browser.close();
    await prisma.$disconnect();
  }

  console.log(`\n${captured} captured, ${skipped.length} skipped.`);
  if (skipped.length > 0) {
    console.log("\nSkipped (listed for the write-up, nothing fabricated in their place):");
    for (const s of skipped) console.log(`  - ${s}`);
  }
  fs.writeFileSync(path.join(outDir, "capture-log.txt"), `${captured} captured, ${skipped.length} skipped.\n\n${skipped.join("\n")}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
