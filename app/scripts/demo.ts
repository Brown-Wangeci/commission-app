/**
 * Local demo, started and stopped with one command each (the fallback when
 * the hosted deployment cannot be used). Unlike `npm run dev:all`, which
 * runs in the foreground until Ctrl+C, this starts everything in the
 * background, waits until each part answers, and returns; `stop` ends it.
 *
 *   start   local PostgreSQL, migrations, the scoring service, the app
 *           (production build; --dev for next dev), and optionally the seed
 *           (--seed) and the scheduler (--scheduler)
 *   stop    stops PostgreSQL cleanly (pg_ctl), then everything else started
 *
 * Usage, from the repository root:
 *   scripts/demo-start.ps1 [-Seed] [-Scheduler] [-Dev]     (Windows)
 *   scripts/demo-start.sh  [--seed] [--scheduler] [--dev]  (macOS, Linux)
 *   scripts/demo-stop.ps1  |  scripts/demo-stop.sh
 *
 * Logs and process ids go to app/.demo/ (not committed).
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { parseEnv } from "node:util";
import { loadEnv } from "./load-env";

const APP_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(APP_DIR, "..");
const STATE_DIR = path.join(APP_DIR, ".demo");
const PIDS_FILE = path.join(STATE_DIR, "pids.json");
const TSX = path.join(APP_DIR, "node_modules", "tsx", "dist", "cli.mjs");
const NEXT = path.join(APP_DIR, "node_modules", "next", "dist", "bin", "next");
const APP_PORT = 3000;

type Pids = Record<string, number>;

function log(message: string): void {
  console.log(`[demo] ${message}`);
}

function readPids(): Pids {
  return fs.existsSync(PIDS_FILE) ? (JSON.parse(fs.readFileSync(PIDS_FILE, "utf8")) as Pids) : {};
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Starts a long-running process in the background, its output in app/.demo/<label>.log. */
function background(label: string, command: string, args: string[], cwd: string, pids: Pids): void {
  const out = fs.openSync(path.join(STATE_DIR, `${label}.log`), "w");
  const child = spawn(command, args, { cwd, env: process.env, detached: true, stdio: ["ignore", out, out], windowsHide: true });
  child.unref();
  pids[label] = child.pid ?? 0;
  fs.writeFileSync(PIDS_FILE, `${JSON.stringify(pids, null, 2)}\n`);
  log(`${label} started (log: app/.demo/${label}.log)`);
}

/** Runs a command to completion in the foreground; stops the demo start if it fails. */
function foreground(label: string, command: string, args: string[], cwd: string): void {
  log(`${label}...`);
  const result = spawnSync(command, args, { cwd, env: process.env, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status}). Run scripts/demo-stop to clean up.`);
}

async function waitFor(label: string, check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) {
      log(`${label} is up`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${label} did not come up within ${timeoutMs / 1000} s. See its log in app/.demo/.`);
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

async function answers(url: string, wantLoaded = false): Promise<boolean> {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) return false;
  return wantLoaded ? Boolean(((await response.json()) as { loaded?: boolean }).loaded) : true;
}

/**
 * The Vercel CLI writes app/.env.local (vercel link, env pull, blob
 * create-store). Next.js reads it ahead of app/.env, so a hosted
 * DATABASE_URL there would point the local demo at the hosted database.
 */
function refuseHostedEnvLocal(): void {
  const file = path.join(APP_DIR, ".env.local");
  if (!fs.existsSync(file)) return;
  const names = Object.keys(parseEnv(fs.readFileSync(file, "utf8")));
  const risky = names.filter((name) => name.startsWith("DATABASE_") || name.startsWith("BLOB_"));
  if (risky.length > 0) {
    throw new Error(`app/.env.local sets ${risky.join(", ")} (written by the Vercel CLI). Remove those lines first: they would point the local demo at the hosted services.`);
  }
}

function scoringPython(): string {
  if (process.env.SCORING_PYTHON) return process.env.SCORING_PYTHON;
  const windows = path.join(REPO_ROOT, ".venv", "Scripts", "python.exe");
  return fs.existsSync(windows) ? windows : path.join(REPO_ROOT, ".venv", "bin", "python");
}

async function startDatabase(pids: Pids): Promise<void> {
  const port = Number(process.env.LOCAL_PG_PORT ?? 5433);
  if (await portOpen(port)) {
    log(`PostgreSQL already listening on ${port}; using it`);
    return;
  }
  background("db", process.execPath, [TSX, "scripts/local-postgres.ts"], APP_DIR, pids);
  await waitFor("PostgreSQL", () => portOpen(port), 120_000);
}

async function startScoring(pids: Pids): Promise<void> {
  const url = new URL(process.env.SCORING_SERVICE_URL ?? "http://127.0.0.1:8000");
  const health = new URL("/health", url).toString();
  if (await answers(health, true).catch(() => false)) {
    log(`scoring service already answering at ${url.origin}; using it`);
    return;
  }
  const args = ["-m", "uvicorn", "src.serve.app:app", "--host", url.hostname, "--port", url.port || "8000"];
  background("scoring", scoringPython(), args, REPO_ROOT, pids);
  await waitFor("scoring service (models loaded)", () => answers(health, true), 180_000);
}

async function startApp(pids: Pids, dev: boolean): Promise<void> {
  if (!dev && !fs.existsSync(path.join(APP_DIR, ".next", "BUILD_ID"))) {
    foreground("production build (first start only)", process.execPath, [NEXT, "build"], APP_DIR);
  }
  background("app", process.execPath, [NEXT, dev ? "dev" : "start", "--port", String(APP_PORT)], APP_DIR, pids);
  await waitFor("app", () => answers(`http://localhost:${APP_PORT}/api/health`), 180_000);
}

async function start(flags: Set<string>): Promise<void> {
  loadEnv();
  refuseHostedEnvLocal();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const pids = readPids();
  const running = Object.entries(pids).filter(([, pid]) => alive(pid));
  if (running.length > 0) throw new Error(`The demo is already running (${running.map(([label]) => label).join(", ")}). Run scripts/demo-stop first.`);
  for (const label of Object.keys(pids)) delete pids[label];
  await startDatabase(pids);
  foreground("migrations", process.execPath, [TSX, "scripts/prisma-env.ts", "migrate", "deploy"], APP_DIR);
  await startScoring(pids);
  if (flags.has("--seed")) foreground("seed", process.execPath, [TSX, "prisma/seed.ts"], APP_DIR);
  await startApp(pids, flags.has("--dev"));
  if (flags.has("--scheduler")) background("scheduler", process.execPath, [TSX, "scripts/scheduler.ts"], APP_DIR, pids);
  log(`ready: http://localhost:${APP_PORT}`);
  log("sign in as reviewer@ledgerfield.test, client@ledgerfield.test or grace@ledgerfield.test; password ledgerfield-demo");
  log("stop with scripts/demo-stop");
}

/** pg_ctl from the embedded-postgres package for this platform, if installed. */
function pgCtl(): string | null {
  const base = path.join(APP_DIR, "node_modules", "@embedded-postgres");
  if (!fs.existsSync(base)) return null;
  for (const platform of fs.readdirSync(base)) {
    for (const name of ["pg_ctl.exe", "pg_ctl"]) {
      const candidate = path.join(base, platform, "native", "bin", name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** A fast shutdown: open connections are closed and the cluster is left consistent. */
function stopDatabase(): void {
  const dataDir = path.resolve(APP_DIR, process.env.LOCAL_PG_DATA_DIR ?? ".pgdata");
  const binary = pgCtl();
  if (!binary || !fs.existsSync(path.join(dataDir, "postmaster.pid"))) return;
  const result = spawnSync(binary, ["stop", "-D", dataDir, "-m", "fast"], { stdio: "inherit" });
  log(result.status === 0 ? "PostgreSQL stopped" : `pg_ctl stop exited ${result.status}`);
}

function kill(label: string, pid: number): void {
  if (!alive(pid)) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      process.kill(pid, "SIGTERM");
    }
  }
  log(`${label} stopped`);
}

function stop(): void {
  loadEnv();
  const pids = readPids();
  if (pids.db) stopDatabase();
  for (const [label, pid] of Object.entries(pids)) kill(label, pid);
  if (fs.existsSync(PIDS_FILE)) fs.rmSync(PIDS_FILE);
  log(Object.keys(pids).length > 0 ? "demo stopped" : "nothing was running from scripts/demo-start");
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "start") return start(new Set(rest));
  if (command === "stop") return stop();
  throw new Error("Usage: tsx scripts/demo.ts start [--seed] [--scheduler] [--dev] | stop");
}

main().catch((error) => {
  console.error(`[demo] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
