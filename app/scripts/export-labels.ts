/**
 * DR-10: writes the reviewed submissions out as a versioned labelled dataset
 * for retraining (src/lib/labels/export.ts), which `python -m src.train.retrain`
 * then reads.
 *
 * Writes <repo>/data/review-labels/<version>/:
 *   labels.jsonl   one row per reviewed submission, no personal data
 *   manifest.json  counts, date range, feature names and the SHA-256 of labels.jsonl
 *
 * data/ is not committed, so an export is evidence only once it is copied
 * somewhere that is.
 *
 * Usage, from app/:
 *   npx tsx scripts/export-labels.ts [out_dir] [--version <name>]
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { exportReviewLabels, serialiseRows, versionFor } from "@/lib/labels/export";
import { loadEnv } from "./load-env";

loadEnv();

const DEFAULT_DIR = path.resolve(__dirname, "..", "..", "data", "review-labels");

function argument(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function main(): Promise<void> {
  const positional = process.argv.slice(2).filter((value, index, all) => !value.startsWith("--") && !all[index - 1]?.startsWith("--"));
  const at = new Date();
  const version = argument("version") ?? versionFor(at);
  const { manifest, rows } = await exportReviewLabels(prisma, { version, at });
  const directory = path.join(positional[0] ?? DEFAULT_DIR, version);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "labels.jsonl"), serialiseRows(rows), "utf8");
  fs.writeFileSync(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const { approved, refused } = manifest.labels;
  console.log(`[export-labels] ${manifest.rows} row(s): ${approved} approved, ${refused} refused`);
  console.log(`[export-labels] modes ${JSON.stringify(manifest.byMode)}; ${manifest.agentGroups} agent group(s)`);
  console.log(`[export-labels] skipped ${JSON.stringify(manifest.skipped)}`);
  console.log(`[export-labels] sha256 ${manifest.sha256}`);
  console.log(`[export-labels] written ${directory}`);
}

main()
  .catch((error) => {
    console.error(`[export-labels] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
