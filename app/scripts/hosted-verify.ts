/**
 * Step 16 of the hosted verification, through the app's own HTTP API only:
 *
 *   run     signs in as each seeded role and checks which areas each may open;
 *           posts a job as client2@, assigns it to Mercy as reviewer@,
 *           submits one activation with three photos as mercy@ (T0 scored in
 *           the request), reports the first week as the client, then waits for
 *           the scoring CRON job to make the T7 decision (nothing is forced),
 *           and fetches every photo back, comparing its SHA-256 with the
 *           bytes uploaded. Writes everything to <out.json>.
 *   photos  fetches the photos named in an earlier <out.json> again (after a
 *           redeploy) and compares them with the same hashes.
 *   review-on   turns "reviewer required before any payment" on as client2@,
 *           posts a one-slot job that follows the account setting, submits one
 *           activation as mercy@, reports an engaged first week, waits for the
 *           scoring cron job's T7 decision and writes where it landed. Leaves
 *           the setting on.
 *   review-off  turns the setting off again as client2@.
 *   open-assignment  posts a one-slot KSh 10.00 job as client2@, assigns it
 *           to mercy@ as reviewer@ and accepts it, leaving it unsubmitted, so
 *           the activation form can be audited (scripts/audit-accessibility.ts).
 *   map-job posts a one-slot job as client2@ through the post-a-job page in
 *           a browser, placing the job area with the map picker: a click on
 *           the map, then "Use my location" with the browser's location set
 *           to the point the other steps use, then the radius slider. It
 *           records the values the picker put in the form, publishes, adds
 *           the demo evidence fields, assigns mercy@, submits one activation
 *           (T0 scored) and opens the review screen as reviewer@ without
 *           deciding. It compares the area the database stored with the
 *           form's values. OpenStreetMap's tile and search hosts are blocked
 *           (their policies forbid automated clients), so no tile or search
 *           request is made.
 *
 * Usage, from app/:
 *   APP_URL=https://<host> npx tsx scripts/hosted-verify.ts run <out.json>
 *   APP_URL=https://<host> npx tsx scripts/hosted-verify.ts photos <out.json> <out2.json>
 *   APP_URL=https://<host> npx tsx scripts/hosted-verify.ts review-on <out.json>
 *   APP_URL=https://<host> npx tsx scripts/hosted-verify.ts review-off <out.json>
 *   APP_URL=https://<host> npx tsx scripts/hosted-verify.ts open-assignment <out.json>
 *   APP_URL=https://<host> npx tsx scripts/hosted-verify.ts map-job <out.json>
 *
 * The customer number it submits is generated, not a real person's.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { acceptAndSubmit, APP, call, DAY, DEMO_EVIDENCE_FIELDS, nairobiDate, signIn, week, type Session } from "./demo-client";
import { placeholderPng } from "../prisma/seed-support/placeholder-png";
import { MAP_HOSTS } from "../src/lib/map/config";
import { RADIUS_STEPS_M } from "../src/lib/map/radius";

type Decision = { mode: string; band: string; probability: number; releaseThreshold: number; rejectThreshold: number; trigger?: string; scoredAt?: string; reasons?: unknown[] };
type Detail = { id: string; reference: string; state: string; submittedAt: string; holdClosesAt: string | null; decisions: Decision[]; photos: Array<{ id: string; url: string; sequence: number }> };
type ReviewDetail = Detail & {
  reviewHistory: Array<{ openReason: string; openedAt: string; closedAt: string | null }>;
  payout: { authorisation: unknown };
  audit: Array<Record<string, unknown>>;
};

const ROLES = { admin: "reviewer@ledgerfield.test", client: "client2@ledgerfield.test", agent: "mercy@ledgerfield.test" } as const;
const AREAS = ["/admin", "/client", "/agent"] as const;
const PHOTO_SIZES = [900, 901, 902];

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const log = (text: string) => console.log(`[hosted-verify] ${text}`);

async function areaStatus(session: Session, area: string): Promise<{ area: string; status: number; location: string | null }> {
  const response = await fetch(`${APP}${area}`, { headers: { cookie: session.cookie }, redirect: "manual" });
  return { area, status: response.status, location: response.headers.get("location") };
}

async function roleChecks(sessions: Record<keyof typeof ROLES, Session>) {
  const checks = [];
  for (const [role, session] of Object.entries(sessions)) {
    for (const area of AREAS) checks.push({ role, email: ROLES[role as keyof typeof ROLES], ...(await areaStatus(session, area)) });
  }
  return checks;
}

async function postJob(client: Session, title = "Hosted verification: wallet activations, Kibuye Market", description = "Hosted verification run (step 16)."): Promise<string> {
  const { jobId } = await call<{ jobId: string }>(client, "POST", "/api/client/jobs", {
    title, description,
    areaName: "Kibuye Market, Kisumu", areaLat: -0.0995, areaLon: 34.768, areaRadiusM: 800,
    submissionValueCents: 250_000, commissionRateBps: 1200, flatCommissionCents: 5_000, slots: 1,
    deadline: nairobiDate(new Date(Date.now() + 30 * DAY)), evidenceFields: DEMO_EVIDENCE_FIELDS,
  });
  return jobId;
}

async function assignMercy(admin: Session, jobId: string): Promise<string> {
  const { agents } = await call<{ agents: Array<{ id: string; email: string }> }>(admin, "GET", "/api/admin/agents");
  const mercy = agents.find((agent) => agent.email === ROLES.agent);
  if (!mercy) throw new Error("Seed agent mercy@ledgerfield.test not found.");
  const { assignmentId } = await call<{ assignmentId: string }>(admin, "POST", `/api/admin/jobs/${jobId}/assign`, { agentId: mercy.id });
  return assignmentId;
}

async function photoChecks(admin: Session, photos: Detail["photos"]) {
  const expected = new Map(PHOTO_SIZES.map((size, index) => [index + 1, sha256(placeholderPng(size))]));
  const results = [];
  for (const photo of photos) {
    const response = await fetch(`${APP}${photo.url}`, { headers: { cookie: admin.cookie } });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const got = sha256(bytes);
    results.push({ id: photo.id, sequence: photo.sequence, status: response.status, contentType: response.headers.get("content-type"), bytes: bytes.length, sha256: got, uploadedSha256: expected.get(photo.sequence) ?? null, matches: got === expected.get(photo.sequence) });
  }
  return results;
}

async function waitForCronT7(admin: Session, id: string, timeoutMs: number): Promise<{ detail: Detail; waitedMs: number }> {
  const started = Date.now();
  for (;;) {
    const detail = await call<Detail>(admin, "GET", `/api/admin/review/${id}`);
    if (detail.decisions.some((d) => d.mode === "t7") || detail.state !== "held") return { detail, waitedMs: Date.now() - started };
    if (Date.now() - started > timeoutMs) throw new Error(`No T7 decision within ${timeoutMs / 1000} s; state ${detail.state}.`);
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
}

async function run(out: string): Promise<void> {
  log(`app ${APP}`);
  const sessions = { admin: await signIn(ROLES.admin), client: await signIn(ROLES.client), agent: await signIn(ROLES.agent) };
  const roles = await roleChecks(sessions);
  for (const check of roles) log(`${check.role} GET ${check.area}: ${check.status}${check.location ? ` -> ${check.location}` : ""}`);
  const jobId = await postJob(sessions.client);
  const assignmentId = await assignMercy(sessions.admin, jobId);
  const submitStarted = Date.now();
  const submitted = await acceptAndSubmit(sessions.agent, assignmentId, "dev-mercy-6120");
  const submitMs = Date.now() - submitStarted;
  const atT0 = await call<Detail>(sessions.admin, "GET", `/api/admin/review/${submitted.activationId}`);
  const t0 = atT0.decisions.find((d) => d.mode === "t0") ?? null;
  log(`${submitted.reference} submitted in ${submitMs} ms (accept, form, multipart submit, T0 scoring); state ${atT0.state}; T0 ${t0 ? `${t0.band} ${t0.probability}` : "none"}`);
  const kind = t0?.band === "auto_release" ? "dormant_lapsed" : "engaged";
  await call(sessions.client, "POST", `/api/client/activations/${submitted.activationId}/activity`, { days: week(kind) });
  log(`first week reported (${kind}); hold closes ${atT0.holdClosesAt}; waiting for the scoring cron job`);
  const photosAtSubmit = await photoChecks(sessions.admin, atT0.photos);
  const { detail: afterT7, waitedMs } = await waitForCronT7(sessions.admin, submitted.activationId, 10 * 60_000);
  const t7 = afterT7.decisions.find((d) => d.mode === "t7") ?? null;
  log(`after ${Math.round(waitedMs / 1000)} s: state ${afterT7.state}; T7 ${t7 ? `${t7.band} ${t7.probability}` : "none"}`);
  const result = {
    app: APP, ran_at: new Date(submitStarted).toISOString(), roles, jobId, assignmentId,
    activation: { id: submitted.activationId, reference: submitted.reference, submittedAt: atT0.submittedAt, holdClosesAt: atT0.holdClosesAt, stateAfterSubmit: atT0.state, submitRequestMs: submitMs },
    t0, firstWeekReported: kind, t7, stateAfterT7: afterT7.state, decisionsAfterT7: afterT7.decisions, waitedForT7Ms: waitedMs,
    photosAtSubmit,
  };
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  log(`photos: ${photosAtSubmit.filter((p) => p.matches).length} of ${photosAtSubmit.length} match the uploaded bytes; written ${out}`);
}

async function photos(previous: string, out: string): Promise<void> {
  const earlier = JSON.parse(fs.readFileSync(previous, "utf8")) as { activation: { id: string; reference: string } };
  const admin = await signIn(ROLES.admin);
  const detail = await call<Detail>(admin, "GET", `/api/admin/review/${earlier.activation.id}`);
  const checks = await photoChecks(admin, detail.photos);
  fs.writeFileSync(out, `${JSON.stringify({ app: APP, checked_at: new Date().toISOString(), activation: earlier.activation, photos: checks }, null, 2)}\n`);
  log(`${earlier.activation.reference}: ${checks.filter((p) => p.matches).length} of ${checks.length} photos match the uploaded bytes; written ${out}`);
}

function setReviewSetting(client: Session, reviewAllSubmissions: boolean): Promise<{ reviewAllSubmissions: boolean; changed: boolean }> {
  return call(client, "POST", "/api/client/review-setting", { reviewAllSubmissions });
}

/** What the check requires of the activation after the cron job's T7 decision, each item true or false. */
function reviewOutcome(detail: ReviewDetail) {
  const t7 = detail.decisions.find((d) => d.mode === "t7") ?? null;
  const open = detail.reviewHistory.filter((item) => item.closedAt === null);
  return {
    t7BandIsAutoRelease: t7?.band === "auto_release",
    inReview: detail.state === "in_review",
    openReason: open.at(-1)?.openReason ?? null,
    scoreAndReasonsStored: detail.decisions.length === 2 && detail.decisions.every((d) => (d.reasons?.length ?? 0) > 0),
    noPayoutAuthorisation: detail.payout.authorisation === null,
  };
}

async function reviewOn(out: string): Promise<void> {
  log(`app ${APP}`);
  const sessions = { admin: await signIn(ROLES.admin), client: await signIn(ROLES.client), agent: await signIn(ROLES.agent) };
  const startedAt = new Date().toISOString();
  const setting = await setReviewSetting(sessions.client, true);
  const jobId = await postJob(sessions.client, "Hosted check: reviewer required, Kibuye Market", "Hosted check of the client review setting.");
  const assignmentId = await assignMercy(sessions.admin, jobId);
  const submitted = await acceptAndSubmit(sessions.agent, assignmentId, "dev-mercy-6120");
  const atT0 = await call<ReviewDetail>(sessions.admin, "GET", `/api/admin/review/${submitted.activationId}`);
  await call(sessions.client, "POST", `/api/client/activations/${submitted.activationId}/activity`, { days: week("engaged") });
  log(`${submitted.reference}: state ${atT0.state} after T0; engaged first week reported; hold closes ${atT0.holdClosesAt}`);
  const { detail, waitedMs } = await waitForCronT7(sessions.admin, submitted.activationId, 10 * 60_000);
  const after = detail as ReviewDetail;
  const outcome = reviewOutcome(after);
  const activation = { id: submitted.activationId, reference: submitted.reference, submittedAt: atT0.submittedAt, holdClosesAt: atT0.holdClosesAt, stateAfterSubmit: atT0.state };
  const result = {
    app: APP, started_at: startedAt, finished_at: new Date().toISOString(), setting, jobId, assignmentId, activation,
    waitedForT7Ms: waitedMs, stateAfterT7: after.state, outcome, decisions: after.decisions, reviewHistory: after.reviewHistory, audit: after.audit,
  };
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  log(`${submitted.reference}: ${JSON.stringify(outcome)}; written ${out}`);
}

async function reviewOff(out: string): Promise<void> {
  const client = await signIn(ROLES.client);
  const setting = await setReviewSetting(client, false);
  fs.writeFileSync(out, `${JSON.stringify({ app: APP, at: new Date().toISOString(), setting }, null, 2)}\n`);
  log(`review setting off (changed: ${setting.changed}); written ${out}`);
}

/** An accepted assignment with nothing submitted, locking KSh 10.00 of client2's escrow. */
async function openAssignment(out: string): Promise<void> {
  log(`app ${APP}`);
  const sessions = { admin: await signIn(ROLES.admin), client: await signIn(ROLES.client), agent: await signIn(ROLES.agent) };
  const { jobId } = await call<{ jobId: string }>(sessions.client, "POST", "/api/client/jobs", {
    title: "Accessibility audit: wallet activations, Kibuye Market", description: "Left unsubmitted so the activation form can be audited.",
    areaName: "Kibuye Market, Kisumu", areaLat: -0.0995, areaLon: 34.768, areaRadiusM: 800,
    submissionValueCents: 10_000, commissionRateBps: 1000, flatCommissionCents: 0, slots: 1,
    deadline: nairobiDate(new Date(Date.now() + 30 * DAY)), evidenceFields: DEMO_EVIDENCE_FIELDS,
  });
  const assignmentId = await assignMercy(sessions.admin, jobId);
  await call(sessions.agent, "POST", `/api/agent/assignments/${assignmentId}/accept`);
  fs.writeFileSync(out, `${JSON.stringify({ app: APP, at: new Date().toISOString(), jobId, assignmentId, lockedCents: 1_000 }, null, 2)}
`);
  log(`assignment accepted, not submitted; written ${out}`);
}

/** The job-area point the API-driven steps post (postJob), so map-job's activation is comparable. */
const KIBUYE = { lat: -0.0995, lon: 34.768 };
const MAP_JOB_RADIUS_M = 1000;

type Page = import("@playwright/test").Page;
type Context = import("@playwright/test").BrowserContext;

async function formArea(page: Page): Promise<{ areaLat: string; areaLon: string; areaRadiusM: string }> {
  return { areaLat: await page.inputValue("#areaLat"), areaLon: await page.inputValue("#areaLon"), areaRadiusM: await page.inputValue("#areaRadiusM") };
}

async function signInBrowser(context: Context, session: Session): Promise<void> {
  const at = session.cookie.indexOf("=");
  const url = new URL(APP);
  await context.clearCookies();
  await context.addCookies([{ name: session.cookie.slice(0, at), value: decodeURIComponent(session.cookie.slice(at + 1)), domain: url.hostname, path: "/", httpOnly: true, secure: url.protocol === "https:", sameSite: "Lax" }]);
}

/** Places the area with the picker (a map click, then the device's location, then the slider) and publishes. */
async function postWithPicker(page: Page) {
  await page.goto(`${APP}/client/jobs/new`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.fill("#title", "Hosted check: map picker, Kibuye Market");
  await page.fill("#description", "Hosted check of the job-area map picker.");
  // "Use my location" places the pin but names nothing; a place search would fill this in.
  await page.fill("#areaName", "Kibuye Market, Kisumu");
  await page.locator(".map-canvas.leaflet-container").waitFor({ timeout: 30_000 });
  // A mouse click lands only inside the viewport, so bring the map into view first.
  await page.locator(".map-canvas").scrollIntoViewIfNeeded();
  const box = (await page.locator(".map-canvas").boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.4);
  await page.waitForFunction(() => (document.querySelector("#areaLat") as HTMLInputElement).value !== "");
  const afterClick = await formArea(page);
  log(`map click placed the pin at ${afterClick.areaLat}, ${afterClick.areaLon}`);
  await page.getByRole("button", { name: "Use my location" }).click();
  await page.waitForFunction((lat) => (document.querySelector("#areaLat") as HTMLInputElement).value === lat, KIBUYE.lat.toFixed(6));
  await page.fill("#areaRadiusRange", String(RADIUS_STEPS_M.indexOf(MAP_JOB_RADIUS_M)));
  const sent = await formArea(page);
  log(`"Use my location" and the slider: ${sent.areaLat}, ${sent.areaLon}, ${sent.areaRadiusM} m`);
  await page.fill("#submissionValueKsh", "2500");
  await page.fill("#commissionRatePercent", "12");
  await page.fill("#flatCommissionKsh", "50");
  await page.fill("#slots", "1");
  await page.locator("#title").click();
  const valueAfterLeaving = await page.inputValue("#submissionValueKsh");
  await page.getByRole("button", { name: "Publish the job" }).click();
  await page.waitForURL(/\/client\/jobs\/[^/?]+\?posted=1/, { timeout: 60_000 });
  const jobId = new URL(page.url()).pathname.split("/").at(-1)!;
  return { afterClick, sent, valueAfterLeaving, jobId };
}

type MapJobDetail = Omit<Detail, "photos"> & { job: { areaLat: number; areaLon: number; areaRadiusM: number }; submission: { kmOutsideArea: number }; photos: Array<{ kmOutsideArea: number | null }> };

async function mapJob(out: string): Promise<void> {
  log(`app ${APP}`);
  const { chromium } = await import("@playwright/test");
  const sessions = { admin: await signIn(ROLES.admin), client: await signIn(ROLES.client), agent: await signIn(ROLES.agent) };
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, geolocation: { latitude: KIBUYE.lat, longitude: KIBUYE.lon }, permissions: ["geolocation"] });
  await context.route((url) => MAP_HOSTS.includes(url.hostname), (route) => route.abort());
  const startedAt = new Date().toISOString();
  try {
    await signInBrowser(context, sessions.client);
    const picker = await postWithPicker(await context.newPage());
    log(`published job ${picker.jobId}`);
    await call(sessions.client, "POST", `/api/client/jobs/${picker.jobId}/evidence-config`, { fields: DEMO_EVIDENCE_FIELDS });
    const assignmentId = await assignMercy(sessions.admin, picker.jobId);
    const submitted = await acceptAndSubmit(sessions.agent, assignmentId, "dev-mercy-6120");
    const detail = await call<MapJobDetail>(sessions.admin, "GET", `/api/admin/review/${submitted.activationId}`);
    const t0 = detail.decisions.find((d) => d.mode === "t0") ?? null;
    await signInBrowser(context, sessions.admin);
    const reviewPage = await context.newPage();
    const response = await reviewPage.goto(`${APP}/admin/review/${submitted.activationId}`, { waitUntil: "networkidle", timeout: 60_000 });
    const reviewScreen = { status: response?.status() ?? null, showsWhereItHappened: (await reviewPage.getByText("Where it happened").count()) > 0, decided: false };
    const stored = { areaLat: detail.job.areaLat, areaLon: detail.job.areaLon, areaRadiusM: detail.job.areaRadiusM };
    const matches = {
      areaLat: stored.areaLat === Number(picker.sent.areaLat),
      areaLon: stored.areaLon === Number(picker.sent.areaLon),
      areaRadiusM: stored.areaRadiusM === Number(picker.sent.areaRadiusM),
      sameCentreAsApiSteps: stored.areaLat === KIBUYE.lat && stored.areaLon === KIBUYE.lon,
    };
    const activation = { id: submitted.activationId, reference: submitted.reference, state: detail.state, submissionKmOutsideArea: detail.submission.kmOutsideArea, photosKmOutsideArea: detail.photos.map((p) => p.kmOutsideArea) };
    const result = { app: APP, started_at: startedAt, finished_at: new Date().toISOString(), mapServicesBlocked: MAP_HOSTS, picker, stored, matches, assignmentId, activation, t0, reviewScreen };
    fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    log(`${submitted.reference}: stored ${JSON.stringify(stored)}; matches ${JSON.stringify(matches)}; state ${detail.state}; T0 ${t0 ? `${t0.band} ${t0.probability}` : "none"}; review screen ${reviewScreen.status}; written ${out}`);
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const [command, a, b] = process.argv.slice(2);
  if (command === "run" && a) return run(a);
  if (command === "photos" && a && b) return photos(a, b);
  if (command === "review-on" && a) return reviewOn(a);
  if (command === "review-off" && a) return reviewOff(a);
  if (command === "open-assignment" && a) return openAssignment(a);
  if (command === "map-job" && a) return mapJob(a);
  throw new Error("Usage: hosted-verify.ts run <out.json> | photos <earlier.json> <out.json> | review-on|review-off|open-assignment|map-job <out.json>");
}

main().catch((error) => {
  console.error(`[hosted-verify] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
