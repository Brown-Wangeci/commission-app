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
 *
 * Usage, from app/:
 *   APP_URL=https://<host> npx tsx scripts/hosted-verify.ts run <out.json>
 *   APP_URL=https://<host> npx tsx scripts/hosted-verify.ts photos <out.json> <out2.json>
 *
 * The customer number it submits is generated, not a real person's.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { acceptAndSubmit, APP, call, DAY, DEMO_EVIDENCE_FIELDS, nairobiDate, signIn, week, type Session } from "./demo-client";
import { placeholderPng } from "../prisma/seed-support/placeholder-png";

type Decision = { mode: string; band: string; probability: number; releaseThreshold: number; rejectThreshold: number; trigger?: string; scoredAt?: string };
type Detail = { id: string; reference: string; state: string; submittedAt: string; holdClosesAt: string | null; decisions: Decision[]; photos: Array<{ id: string; url: string; sequence: number }> };

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

async function postJob(client: Session): Promise<string> {
  const { jobId } = await call<{ jobId: string }>(client, "POST", "/api/client/jobs", {
    title: "Hosted verification: wallet activations, Kibuye Market", description: "Hosted verification run (step 16).",
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

async function main(): Promise<void> {
  const [command, a, b] = process.argv.slice(2);
  if (command === "run" && a) return run(a);
  if (command === "photos" && a && b) return photos(a, b);
  throw new Error("Usage: hosted-verify.ts run <out.json> | photos <earlier.json> <out.json>");
}

main().catch((error) => {
  console.error(`[hosted-verify] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
