/**
 * Section F: captures the Chapter 5 screenshots with Playwright against a
 * running app on seeded data. Figures are numbered figure-5-01 onward;
 * docs/chapter5/evidence/screenshots/captions.md carries one factual caption
 * per figure, written by hand against what was actually captured (not
 * generated here), after reviewing the output.
 *
 * The seed is deterministic from an empty database, so the named cases below
 * use the exact reference numbers DEMO.md already documents for a fresh seed
 * run (LF-000047 Samuel disputed, LF-000050 Grace's mockup/evidence-round-trip
 * case, LF-000055 Faith could-not-be-scored, LF-000056 Mercy awaiting
 * evidence). If a reference has shifted because the seed changed, this script
 * looks the case up by its real characteristics instead of failing blind.
 *
 * Usage: npx tsx scripts/capture-screenshots.ts <out_dir>
 * Prerequisites: the app running (npm start) against a freshly seeded
 * database, at APP_URL (default http://localhost:3000).
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { APP, signIn } from "./demo-client";
import { loadEnv } from "./load-env";

loadEnv();

const VIEWPORT = { width: 1360, height: 900 };
const skipped: string[] = [];
let n = 0;

function pad(num: number): string {
  return String(num).padStart(2, "0");
}

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

async function shot(page: Page, outDir: string, slug: string, path_: string, options: { fullPage?: boolean; wait?: string } = {}): Promise<void> {
  n += 1;
  const name = `figure-5-${pad(n)}-${slug}`;
  try {
    await page.goto(`${APP}${path_}`, { waitUntil: "networkidle", timeout: 20_000 });
    if (options.wait) await page.waitForSelector(options.wait, { timeout: 10_000 }).catch(() => undefined);
    await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: options.fullPage ?? true });
    console.log(`  ok    ${name}  <-  ${path_}`);
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
  const anyJob = await prisma.job.findFirst({ where: { client: { user: { email: "client2@ledgerfield.test" } } }, select: { id: true }, orderBy: { createdAt: "asc" } });
  const payoutsWithFailure = await prisma.disbursement.findFirst({ where: { status: "failed" }, select: { activationId: true } });
  console.log({ disputedId, inReviewMockup, couldNotBeScored: couldNotBeScored?.id, awaitingEvidence, anyJob: anyJob?.id });

  const browser = await chromium.launch();
  try {
    const agentCtx = await contextFor(browser, "mercy@ledgerfield.test");
    const adminCtx = await contextFor(browser, "reviewer@ledgerfield.test");
    const clientCtx = await contextFor(browser, "client2@ledgerfield.test");
    const agent = await agentCtx.newPage();
    const admin = await adminCtx.newPage();
    const client = await clientCtx.newPage();

    // Agent submission form.
    const assignment = await prisma.assignment.findFirst({ where: { agent: { user: { email: "mercy@ledgerfield.test" } }, acceptedAt: { not: null }, activation: null }, select: { id: true } });
    if (assignment) await shot(agent, outDir, "agent-submission-form", `/agent/submit/${assignment.id}`, { wait: "form" });
    else skipped.push("figure-5-agent-submission-form: no unsubmitted accepted assignment in seed data");

    // Agent status list with a decision reason.
    await shot(agent, outDir, "agent-status-list", "/agent/activations", { wait: "main" });

    // Admin review queue.
    await shot(admin, outDir, "admin-review-queue", "/admin/review", { wait: "table, .empty" });

    // Admin review screen for the mockup case.
    if (inReviewMockup) await shot(admin, outDir, "admin-review-mockup-case", `/admin/review/${inReviewMockup}`, { wait: "#decide" });

    // Awaiting-evidence round trip.
    if (awaitingEvidence) await shot(admin, outDir, "awaiting-evidence", `/admin/review/${awaitingEvidence}`, { wait: "#decide" });

    // Could-not-be-scored item.
    if (couldNotBeScored) await shot(admin, outDir, "could-not-be-scored", `/admin/review/${couldNotBeScored.id}`, { wait: "#decide" });
    else skipped.push("figure-5-could-not-be-scored: no activation with a scoring_failed audit event and no decision found in seed data");

    // Client job and escrow view.
    await shot(client, outDir, "client-escrow-and-jobs", "/client", { wait: "table, .empty" });
    if (anyJob) await shot(client, outDir, "client-job-detail", `/client/jobs/${anyJob.id}`, { wait: "table, .empty" });

    // Payouts page including a failed payout.
    await shot(admin, outDir, "payouts-with-failure", "/admin/payouts", { wait: "table, .empty" });

    // Audit log with anchor status.
    await shot(admin, outDir, "audit-log-with-anchoring", "/admin/audit", { wait: "table" });

    // Dispute verification result (the audit panel on a disputed submission).
    if (disputedId) {
      await admin.goto(`${APP}/admin/review/${disputedId}`, { waitUntil: "networkidle" });
      const verifyButton = admin.getByRole("button", { name: /Verify against the blockchain/i });
      if (await verifyButton.count()) {
        await verifyButton.click();
        await admin.waitForTimeout(1500);
      }
      n += 1;
      const name = `figure-5-${pad(n)}-dispute-verification-result`;
      await admin.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true });
      console.log(`  ok    ${name}  <-  /admin/review/${disputedId} (after Verify)`);
    } else {
      skipped.push("figure-5-dispute-verification-result: no disputed activation found in seed data");
    }

    // Validation / error states.
    const anonContext = await browser.newContext({ viewport: VIEWPORT });
    const anon = await anonContext.newPage();
    await anon.goto(`${APP}/signup`, { waitUntil: "networkidle" });
    await anon.getByLabel("A client business").check();
    await anon.getByLabel("Your full name").fill("Test Duplicate");
    await anon.getByLabel("Email").fill("client2@ledgerfield.test");
    await anon.getByLabel("Password").fill("ledgerfield-demo");
    await anon.getByLabel("Business name").fill("Test Co");
    await anon.getByRole("button", { name: /Create account/i }).click();
    await anon.waitForSelector(".alert.error, .field-error", { timeout: 10_000 }).catch(() => undefined);
    n += 1;
    const signupName = `figure-5-${pad(n)}-validation-signup-duplicate-email`;
    await anon.screenshot({ path: path.join(outDir, `${signupName}.png`), fullPage: true });
    console.log(`  ok    ${signupName}  <-  /signup (submitted with an email already registered)`);
    await anonContext.close();

    await client.goto(`${APP}/client/jobs/new`, { waitUntil: "networkidle" });
    const publishButton = client.getByRole("button", { name: /Publish/i });
    if (await publishButton.count()) {
      await publishButton.click().catch(() => undefined);
      await client.waitForTimeout(500);
    }
    n += 1;
    let name = `figure-5-${pad(n)}-validation-empty-job-form`;
    await client.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true });
    console.log(`  ok    ${name}  <-  /client/jobs/new (submitted empty)`);

    await admin.goto(`${APP}/admin/review/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`, { waitUntil: "networkidle" }).catch(() => undefined);
    n += 1;
    name = `figure-5-${pad(n)}-validation-not-found`;
    await admin.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true });
    console.log(`  ok    ${name}  <-  a non-existent activation id`);

    const unauthResponse = await client.request.get(`${APP}/api/admin/review`).catch(() => null);
    n += 1;
    name = `figure-5-${pad(n)}-validation-forbidden-role`;
    await client.goto(`${APP}/client`, { waitUntil: "networkidle" });
    await client.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true });
    console.log(`  ok    ${name}  <-  client session, /admin/review returned HTTP ${unauthResponse?.status()}`);

    await agentCtx.close();
    await adminCtx.close();
    await clientCtx.close();
  } finally {
    await browser.close();
    await prisma.$disconnect();
  }

  console.log(`\n${n} screenshots attempted, ${skipped.length} skipped.`);
  if (skipped.length > 0) {
    console.log("\nSkipped (list for the write-up, nothing fabricated in their place):");
    for (const s of skipped) console.log(`  - ${s}`);
  }
  fs.writeFileSync(path.join(outDir, "capture-log.txt"), `${n} attempted, ${skipped.length} skipped.\n\n${skipped.join("\n")}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
