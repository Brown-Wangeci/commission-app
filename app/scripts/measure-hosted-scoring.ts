/**
 * NFR-02 against the hosted scoring service. Read-only: nothing is written to
 * the database. Three views, because no single number is fair from a laptop:
 *
 *   1. Round trip from this machine to the scoring service, for every stored
 *      request the app can build from the database DATABASE_URL names (T0 for
 *      each activation, T7 where one can be built), sent one at a time, in
 *      PASSES passes. Includes the network between this machine and the
 *      service.
 *   2. The network alone: GET /health from this machine, many times. The
 *      difference between the two is the service's own time, approximately.
 *   3. Durations the deployed app recorded itself (ScoringAttempt.durationMs)
 *      for calls it made from Vercel (fra1) to the service, after the seed
 *      finished. That is the path NFR-02 is about; there are few of them.
 *
 * Why not scripts/measure_scoring_latency.py: it sends each activation's full
 * 90-day history from the synthetic dataset, 7 to 34 MB a request in a probe, which over
 * the internet measures the uplink, not the service (see
 * docs/chapter5/evidence/hosted/performance/README.md).
 *
 * Usage, from app/:
 *   node --env-file=.env.hosted node_modules/tsx/dist/cli.mjs scripts/measure-hosted-scoring.ts <out.json>
 * SCORING_SERVICE_URL (from the pulled settings) names the service; SEED_DONE_AT
 * (ISO time) marks the start of the app-originated attempts.
 */
import fs from "node:fs";
import { prisma } from "@/lib/db";
import { buildScoreRequest, PayloadError } from "@/lib/scoring/payload";

const SERVICE = (process.env.SCORING_SERVICE_URL ?? "").replace(/\/$/, "");
const PASSES = Number(process.env.PASSES ?? 2);
const HEALTH_CALLS = 30;
const TARGET_S = 1;
const SEED_DONE_AT = new Date(process.env.SEED_DONE_AT ?? "2026-11-15T09:34:00Z");

type Timed = { seconds: number; ok: boolean };

function percentile(sorted: number[], p: number): number {
  return sorted.length === 0 ? Number.NaN : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function summarise(samples: Timed[]) {
  const s = samples.map((x) => x.seconds).sort((a, b) => a - b);
  const within = s.filter((x) => x <= TARGET_S).length;
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  return { n: s.length, errors: samples.filter((x) => !x.ok).length, mean_s: mean, p50_s: percentile(s, 50), p95_s: percentile(s, 95), p99_s: percentile(s, 99), max_s: s.at(-1) ?? null, min_s: s[0] ?? null, within_1s: within, within_1s_share: within / (s.length || 1) };
}

async function timed(call: () => Promise<Response>): Promise<Timed> {
  const started = performance.now();
  try {
    const response = await call();
    await response.arrayBuffer();
    return { seconds: (performance.now() - started) / 1000, ok: response.ok };
  } catch {
    return { seconds: (performance.now() - started) / 1000, ok: false };
  }
}

async function storedRequests(): Promise<Array<{ reference: string; mode: "t0" | "t7"; body: string }>> {
  const rows = await prisma.activation.findMany({ orderBy: { reference: "asc" }, select: { id: true, reference: true } });
  const out: Array<{ reference: string; mode: "t0" | "t7"; body: string }> = [];
  for (const a of rows) {
    for (const mode of ["t0", "t7"] as const) {
      try {
        out.push({ reference: a.reference, mode, body: JSON.stringify(await buildScoreRequest(prisma, a.id, mode)) });
      } catch (error) {
        if (!(error instanceof PayloadError)) throw error;
      }
    }
  }
  return out;
}

async function appRecorded() {
  const rows = await prisma.scoringAttempt.findMany({ where: { attemptedAt: { gte: SEED_DONE_AT }, outcome: "succeeded" }, select: { mode: true, durationMs: true, attemptedAt: true }, orderBy: { attemptedAt: "asc" } });
  return { since: SEED_DONE_AT.toISOString(), calls: rows.map((r) => ({ mode: r.mode, seconds: r.durationMs / 1000, at: r.attemptedAt.toISOString() })), ...summarise(rows.map((r) => ({ seconds: r.durationMs / 1000, ok: true }))) };
}

async function main(): Promise<void> {
  if (!SERVICE) throw new Error("SCORING_SERVICE_URL is not set.");
  const requests = await storedRequests();
  const sizes = requests.map((r) => r.body.length).sort((a, b) => a - b);
  console.log(`${requests.length} stored requests, ${sizes[0]} to ${sizes.at(-1)} bytes; ${PASSES} passes.`);
  await fetch(`${SERVICE}/health`);
  const health: Timed[] = [];
  for (let i = 0; i < HEALTH_CALLS; i += 1) health.push(await timed(() => fetch(`${SERVICE}/health`)));
  const byMode: Record<string, Timed[]> = { t0: [], t7: [] };
  for (let pass = 0; pass < PASSES; pass += 1) {
    for (const r of requests) byMode[r.mode].push(await timed(() => fetch(`${SERVICE}/score`, { method: "POST", headers: { "Content-Type": "application/json" }, body: r.body })));
    console.log(`pass ${pass + 1} of ${PASSES} done`);
  }
  const report = {
    measured_at: new Date().toISOString(),
    service: SERVICE,
    client: "developer laptop, Nairobi (not the deployed app)",
    requests_per_pass: requests.length,
    passes: PASSES,
    request_bytes: { min: sizes[0], median: sizes[Math.floor(sizes.length / 2)], max: sizes.at(-1) },
    target_seconds: TARGET_S,
    round_trip_from_this_machine: { overall: summarise([...byMode.t0, ...byMode.t7]), t0: summarise(byMode.t0), t7: summarise(byMode.t7) },
    network_baseline_health_from_this_machine: summarise(health),
    recorded_by_deployed_app: await appRecorded(),
  };
  fs.writeFileSync(process.argv[2], `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ roundTrip: report.round_trip_from_this_machine.overall, baseline: report.network_baseline_health_from_this_machine, app: { n: report.recorded_by_deployed_app.n, mean_s: report.recorded_by_deployed_app.mean_s, max_s: report.recorded_by_deployed_app.max_s } }, null, 1));
}

main().finally(() => prisma.$disconnect());
