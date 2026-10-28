/**
 * Starts everything the demo needs, with labelled output, and stops it all on
 * Ctrl+C:
 *   db        local PostgreSQL (skipped with --no-db, e.g. when using Docker or a hosted database)
 *   scoring   the FastAPI scoring service at the repository root
 *   app       Next.js (dev server, or the production build with --prod)
 *   scheduler the T7 / retry scheduler, only with --scheduler, and only once
 *             the scoring service reports its models loaded (a scheduler
 *             that polls first would find the service down and correctly,
 *             but needlessly, send due activations to review as unscored)
 *
 * Usage: npm run dev:all [-- --prod] [-- --no-db] [-- --scheduler]
 *
 * The scoring service is started with the Python in SCORING_PYTHON, or the
 * repository's .venv by default.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "./load-env";

loadEnv();

const APP_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(APP_DIR, "..");
const args = new Set(process.argv.slice(2));
const children: ChildProcess[] = [];

function defaultPython(): string {
  const windows = path.join(REPO_ROOT, ".venv", "Scripts", "python.exe");
  const posix = path.join(REPO_ROOT, ".venv", "bin", "python");
  return fs.existsSync(windows) ? windows : posix;
}

function scoringAddress(): { host: string; port: string } {
  const url = new URL(process.env.SCORING_SERVICE_URL ?? "http://127.0.0.1:8000");
  return { host: url.hostname, port: url.port || "8000" };
}

function start(label: string, command: string, commandArgs: string[], cwd: string): void {
  const child = spawn(command, commandArgs, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = `[${label.padEnd(9)}]`;
  const forward = (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) console.log(`${prefix} ${line}`);
  };
  child.stdout?.on("data", forward);
  child.stderr?.on("data", forward);
  child.on("exit", (code) => console.log(`${prefix} exited with code ${code}`));
  children.push(child);
}

function nodeScript(file: string, extra: string[] = []): [string, string[]] {
  return [process.execPath, [path.join(APP_DIR, "node_modules", "tsx", "dist", "cli.mjs"), file, ...extra]];
}

async function scoringReady(timeoutMs: number): Promise<boolean> {
  const url = new URL("/health", process.env.SCORING_SERVICE_URL ?? "http://127.0.0.1:8000");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const body = (await (await fetch(url, { signal: AbortSignal.timeout(2000) })).json()) as { loaded?: boolean };
      if (body.loaded) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

async function startScheduler(): Promise<void> {
  if (!(await scoringReady(180_000))) console.log("[run-all  ] scoring service not ready after 3 minutes; starting the scheduler anyway");
  start("scheduler", ...nodeScript("scripts/scheduler.ts"), APP_DIR);
}

function main(): void {
  if (!args.has("--no-db")) start("db", ...nodeScript("scripts/local-postgres.ts"), APP_DIR);
  const { host, port } = scoringAddress();
  const python = process.env.SCORING_PYTHON ?? defaultPython();
  start("scoring", python, ["-m", "uvicorn", "src.serve.app:app", "--host", host, "--port", port], REPO_ROOT);
  const next = path.join(APP_DIR, "node_modules", "next", "dist", "bin", "next");
  start("app", process.execPath, [next, args.has("--prod") ? "start" : "dev", "--port", "3000"], APP_DIR);
  if (args.has("--scheduler")) void startScheduler();
  console.log("Starting. The app is at http://localhost:3000 once [app] reports Ready. Ctrl+C stops everything.");
}

function stopAll(): void {
  for (const child of children) child.kill("SIGINT");
  setTimeout(() => process.exit(0), 3000);
}

process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);
main();
