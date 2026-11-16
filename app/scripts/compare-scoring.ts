/**
 * Sends the same stored scoring requests to two scoring services and compares
 * the answers exactly (raw score, calibrated probability, band, thresholds and
 * every feature value). Each request is built once by the app
 * (buildScoreRequest) from the database DATABASE_URL names: T0 for every
 * activation, and T7 wherever a T7 request can be built. Read-only: nothing
 * is written to the database, and the scoring services store only their own
 * prediction logs.
 *
 * Evidence: docs/chapter5/evidence/hosted/scoring/model-match-after-redeploy.md
 *
 * Usage, from app/, with the local service running on port 8000:
 *   node --env-file=.env.hosted node_modules/tsx/dist/cli.mjs scripts/compare-scoring.ts <out.json>
 * COMPARE_A_URL and COMPARE_B_URL override the two services (defaults: the
 * local service and the Render service).
 */
import fs from "node:fs";
import { prisma } from "@/lib/db";
import { buildScoreRequest, PayloadError } from "@/lib/scoring/payload";

type Score = Record<string, unknown>;
const LOCAL = process.env.COMPARE_A_URL ?? "http://127.0.0.1:8000";
const RENDER = process.env.COMPARE_B_URL ?? "https://ledgerfield-scoring.onrender.com";

async function score(base: string, payload: unknown): Promise<Score> {
  const r = await fetch(new URL("/score", base), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error(`${base} HTTP ${r.status}`);
  return (await r.json()) as Score;
}

function featureDiffs(a: Record<string, unknown>, b: Record<string, unknown>) {
  return Object.keys({ ...a, ...b }).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => ({ feature: k, local: a[k], render: b[k] }));
}

async function main() {
  const rows = await prisma.activation.findMany({ orderBy: { reference: "asc" }, select: { id: true, reference: true } });
  const results: Array<Record<string, unknown>> = [];
  for (const a of rows) {
    for (const mode of ["t0", "t7"] as const) {
      let payload;
      try { payload = await buildScoreRequest(prisma, a.id, mode); } catch (e) { if (e instanceof PayloadError) continue; throw e; }
      const [l, r] = await Promise.all([score(LOCAL, payload), score(RENDER, payload)]);
      const diffs = featureDiffs(l.feature_vector as Record<string, unknown>, r.feature_vector as Record<string, unknown>);
      results.push({
        reference: a.reference, mode,
        local: { raw: l.raw_score, probability: l.calibrated_probability, band: l.band, model: l.model_version },
        render: { raw: r.raw_score, probability: r.calibrated_probability, band: r.band, model: r.model_version },
        raw_equal: l.raw_score === r.raw_score, probability_equal: l.calibrated_probability === r.calibrated_probability,
        band_equal: l.band === r.band, features_equal: diffs.length === 0, feature_differences: diffs,
        thresholds_equal: l.release_threshold === r.release_threshold && l.reject_threshold === r.reject_threshold,
      });
    }
  }
  const count = (key: string) => results.filter((x) => x[key] === true).length;
  const summary = { measured_at: new Date().toISOString(), requests: results.length, t0: results.filter((x) => x.mode === "t0").length, t7: results.filter((x) => x.mode === "t7").length,
    raw_equal: count("raw_equal"), probability_equal: count("probability_equal"), band_equal: count("band_equal"), features_equal: count("features_equal"), thresholds_equal: count("thresholds_equal") };
  fs.writeFileSync(process.argv[2], `${JSON.stringify({ summary, results }, null, 2)}\n`);
  console.log(JSON.stringify(summary));
  for (const x of results.filter((x) => !x.raw_equal)) console.log("RAW DIFFERS", x.reference, x.mode);
  const seen = new Map<string, string>();
  for (const x of results) for (const d of x.feature_differences as Array<{ feature: string; local: unknown; render: unknown }>) if (!seen.has(d.feature)) seen.set(d.feature, `${x.reference}/${x.mode}: local ${JSON.stringify(d.local)} render ${JSON.stringify(d.render)}`);
  for (const [f, ex] of seen) console.log("FEATURE DIFFERS", f, "e.g.", ex);
}
main().finally(() => prisma.$disconnect());
