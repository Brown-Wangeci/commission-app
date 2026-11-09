/**
 * NFR-01: load test of application API endpoints that do not depend on an
 * external service, at 100 concurrent users, reporting the share completing
 * within 2 seconds.
 *
 * Deliberately excludes any route that calls Daraja, the scoring service, or
 * the blockchain -- including /api/health, which itself calls the scoring
 * service's own /health endpoint and so does not qualify. The three routes
 * below each read only from this app's own PostgreSQL database.
 *
 * This runs against the developer machine named in
 * docs/chapter5/environment.md: there is no hosted deployment to test
 * against (see "Known limitations" in README.md). It is not a measurement of
 * production infrastructure.
 *
 * Usage:
 *   npm run db:seed   (if not already seeded)
 *   npm start          (or npm run dev, against the seeded database)
 *   APP_URL=http://localhost:3000 npx tsx scripts/load-test.ts
 *
 * VUS and DURATION_MS are overridable by environment variable for a quick
 * smoke run; the default (100 users, 30s) is what NFR-01 specifies.
 */
import { loadEnv } from "./load-env";

loadEnv();

const APP = process.env.APP_URL ?? "http://localhost:3000";
const VUS = Number(process.env.LOAD_TEST_VUS ?? 100);
const DURATION_MS = Number(process.env.LOAD_TEST_DURATION_MS ?? 30_000);
const TARGET_MS = 2000;

type Sample = { route: string; ms: number; status: number; ok: boolean };

async function signIn(email: string): Promise<string> {
  const csrf = await fetch(`${APP}/api/auth/csrf`);
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  const cookie = csrf.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const response = await fetch(`${APP}/api/auth/callback/credentials`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ csrfToken, email, password: "ledgerfield-demo", json: "true" }),
  });
  const session = response.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.includes("session-token="));
  if (!session) throw new Error(`Sign-in failed for ${email}: HTTP ${response.status}`);
  return session;
}

type Route = { name: string; path: string; cookie: string };

async function buildRoutes(): Promise<Route[]> {
  const admin = await signIn("reviewer@ledgerfield.test");
  const client = await signIn("client2@ledgerfield.test");
  const { prisma } = await import("../src/lib/db");
  const any = await prisma.activation.findFirstOrThrow({ orderBy: { submittedAt: "asc" } });
  await prisma.$disconnect();
  return [
    { name: "GET /api/client/escrow", path: "/api/client/escrow", cookie: client },
    { name: "GET /api/admin/review?tab=waiting", path: "/api/admin/review?tab=waiting", cookie: admin },
    { name: `GET /api/admin/activations/[id]/audit`, path: `/api/admin/activations/${any.id}/audit`, cookie: admin },
  ];
}

async function oneCall(route: Route): Promise<Sample> {
  const started = performance.now();
  try {
    const response = await fetch(`${APP}${route.path}`, { headers: { cookie: route.cookie } });
    await response.arrayBuffer();
    return { route: route.name, ms: performance.now() - started, status: response.status, ok: response.ok };
  } catch {
    return { route: route.name, ms: performance.now() - started, status: 0, ok: false };
  }
}

async function worker(routes: Route[], deadline: number, samples: Sample[]): Promise<void> {
  let i = 0;
  while (performance.now() < deadline) {
    samples.push(await oneCall(routes[i % routes.length]));
    i += 1;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

function summarise(samples: Sample[], label: string): void {
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const errors = samples.filter((s) => !s.ok).length;
  const within = samples.filter((s) => s.ms <= TARGET_MS).length;
  const mean = ms.reduce((a, b) => a + b, 0) / (ms.length || 1);
  console.log(`\n${label}`);
  console.log(`  requests: ${samples.length}, errors: ${errors}`);
  console.log(`  mean: ${mean.toFixed(1)} ms, p50: ${percentile(ms, 50).toFixed(1)} ms, p95: ${percentile(ms, 95).toFixed(1)} ms, p99: ${percentile(ms, 99).toFixed(1)} ms, max: ${ms[ms.length - 1]?.toFixed(1)} ms`);
  console.log(`  within ${TARGET_MS} ms: ${within} of ${samples.length} (${((within / (samples.length || 1)) * 100).toFixed(2)}%)`);
}

async function main(): Promise<void> {
  const routes = await buildRoutes();
  console.log(`Target: ${APP}`);
  console.log(`Routes under test (no external service dependency):`);
  for (const r of routes) console.log(`  - ${r.name}`);
  console.log(`${VUS} concurrent virtual users for ${DURATION_MS / 1000}s...`);

  const deadline = performance.now() + DURATION_MS;
  const perWorkerSamples: Sample[][] = Array.from({ length: VUS }, () => []);
  await Promise.all(Array.from({ length: VUS }, (_, i) => worker(routes, deadline, perWorkerSamples[i])));
  const all = perWorkerSamples.flat();

  summarise(all, "Overall (every route pooled)");
  for (const route of routes) summarise(all.filter((s) => s.route === route.name), route.name);

  const within = all.filter((s) => s.ms <= TARGET_MS).length;
  const share = within / (all.length || 1);
  console.log(`\nNFR-01: ${(share * 100).toFixed(2)}% of ${all.length} requests completed within ${TARGET_MS} ms at ${VUS} concurrent users.`);
  console.log(`Target is 95%. ${share >= 0.95 ? "MET" : "NOT MET"}.`);

  const fs = await import("node:fs");
  const out = {
    app: APP,
    vus: VUS,
    durationMs: DURATION_MS,
    targetMs: TARGET_MS,
    totalRequests: all.length,
    errors: all.filter((s) => !s.ok).length,
    shareWithinTarget: share,
    meetsNfr01: share >= 0.95,
    overall: { mean: all.reduce((a, s) => a + s.ms, 0) / (all.length || 1), p50: percentile(all.map((s) => s.ms).sort((a, b) => a - b), 50), p95: percentile(all.map((s) => s.ms).sort((a, b) => a - b), 95), p99: percentile(all.map((s) => s.ms).sort((a, b) => a - b), 99), max: Math.max(...all.map((s) => s.ms)) },
    byRoute: routes.map((r) => {
      const s = all.filter((x) => x.route === r.name).map((x) => x.ms).sort((a, b) => a - b);
      return { route: r.name, requests: s.length, mean: s.reduce((a, b) => a + b, 0) / (s.length || 1), p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99), max: s[s.length - 1] ?? null };
    }),
  };
  const dir = process.argv[2] ?? "../docs/chapter5/evidence/performance";
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/nfr01-load-test.json`, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`\nWrote ${dir}/nfr01-load-test.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
