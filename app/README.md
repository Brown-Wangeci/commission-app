# Ledgerfield

Ledgerfield manages commission payouts for independent sales agents. A client
business posts a job and locks money in escrow. The platform assigns the job
to an agent, who signs a customer up and submits the activation with photo
evidence. The fraud-scoring service in this repository scores it twice: at
submission (T0) and when the seven-day hold window closes (T7). Each score
leads to automatic release, human review or refusal. A reviewer decides
everything in between, with the model's advice in front of them.

This folder is the application. The scoring service is the Python project at
the repository root; the app calls it over HTTP and never imports its code.

```
 browser ── Next.js app (this folder) ──HTTP──> scoring service (repo root, FastAPI)
                 │                                   POST /score  (mode t0 | t7)
                 │                                   GET  /health
                 ▼
            PostgreSQL  <── scheduler (npm run scheduler): T7 at hold-close, retries
```

- [DEMO.md](DEMO.md): the demonstration path, click by click.
- [BUILD_LOG.md](BUILD_LOG.md): every decision, assumption and gap from the
  build, issue by issue.

## Requirements

- Node.js 22 or later (built and tested on 24.14) and npm.
- The scoring service's Python environment, set up as described in the
  root `README.md` (the `.venv` with the trained artifacts in `artifacts/`).
- PostgreSQL. `npm run db:start` runs PostgreSQL 17 from an npm package
  (`embedded-postgres`), so nothing else is needed for local work. Any
  PostgreSQL 14 or later works by changing `DATABASE_URL`.

## First-time setup

From `app/`:

```
npm install
copy .env.example .env          (macOS/Linux: cp .env.example .env)
```

Edit `.env` and replace the three `replace-with-a-long-random-string` values
(`NEXTAUTH_SECRET`, `CRON_SECRET`, `MSISDN_HASH_SALT`) with random strings:

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Then create the database schema and the demo data:

```
npm run db:start                (leave running; local PostgreSQL on port 5433)
npm run db:migrate              (in a second terminal)
```

Start the scoring service (see below), then:

```
npm run db:seed
```

## Running the app and the scoring service together

**One command** (from `app/`):

```
npm run dev:all                       database, scoring service, app (dev mode)
npm run dev:all -- --scheduler        ...plus the scheduler, once scoring is up
npm run dev:all -- --prod             production build (run npm run build first)
npm run dev:all -- --no-db            when PostgreSQL runs elsewhere
```

Output is labelled `[db]`, `[scoring]`, `[app]`, `[scheduler]`; Ctrl+C stops
all of them. The scoring service is started with the repository's `.venv`
Python, or `SCORING_PYTHON` if set.

**Or separate terminals:**

| What | From | Command |
|---|---|---|
| Database | `app/` | `npm run db:start` |
| Scoring service | repository root | `.venv\Scripts\python.exe -m uvicorn src.serve.app:app --host 127.0.0.1 --port 8000` (macOS/Linux: `.venv/bin/python -m ...`) |
| App | `app/` | `npm run dev`, or `npm run build` then `npm start` |
| Scheduler (optional) | `app/` | `npm run scheduler` |

Open http://localhost:3000. `GET /api/health` reports whether the database
and the scoring service are reachable.

The scoring service must be listening at `SCORING_SERVICE_URL` (default
`http://127.0.0.1:8000`). If it is not, nothing breaks silently: submissions
go to the review queue marked "could not be scored" and are retried in the
background.

### The scheduler

T7 scoring at hold-close, and retries after scoring failures, are rows in the
`ScoringJob` table. `npm run scheduler` polls for due rows every
`SCHEDULER_INTERVAL_SECONDS` and runs them. Nothing is kept in memory, so it
can be stopped and restarted freely, and several copies can run at once. Two
manual triggers exist for when it is not running:

- the Dashboard buttons **Run due scoring now** and **Force T7 now**;
- `POST /api/cron/scoring` with `Authorization: Bearer $CRON_SECRET`, for a
  hosted cron service.

`HOLD_WINDOW_SECONDS` sets the hold window (default 604800, seven days). Set
it to, say, 120 for a live demonstration of the scheduled path.

## Configuration

All configuration comes from environment variables; `.env.example` lists
every one with its default. Nothing secret is committed.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | local, port 5433 | PostgreSQL connection |
| `TEST_DATABASE_URL` | local `ledgerfield_test` | Server the test suite creates throwaway databases on |
| `NEXTAUTH_SECRET`, `NEXTAUTH_URL` | (required) | Session signing and the app's public URL |
| `SCORING_SERVICE_URL` | `http://127.0.0.1:8000` | Scoring service base URL |
| `SCORING_TIMEOUT_MS` | 15000 | Per-call timeout |
| `SCORING_IMMEDIATE_ATTEMPTS`, `SCORING_IMMEDIATE_BACKOFF_MS` | 3, 500 | Quick retries within one scoring run |
| `SCORING_RETRY_BASE_SECONDS`, `SCORING_MAX_RUNS` | 60, 6 | Background retries after a failed run (doubling) |
| `HOLD_WINDOW_SECONDS` | 604800 | Submission to hold-close |
| `SCHEDULER_INTERVAL_SECONDS`, `SCHEDULER_LEASE_SECONDS` | 30, 120 | Scheduler polling and job lease |
| `CRON_SECRET` | (unset = disabled) | Guards `POST /api/cron/scoring` |
| `PAYOUT_AUTHORISER` | `noop` | Payout boundary implementation (only `noop` exists) |
| `MSISDN_HASH_SALT` | (required) | Salt for hashing customer numbers |
| `EVIDENCE_STORAGE_DIR`, `EVIDENCE_MAX_BYTES` | `storage/evidence`, 8000000 | Where evidence files go, and the per-file limit |
| `SCORING_PYTHON` | repo `.venv` | Python used by `npm run dev:all` |
| `LOCAL_PG_*` | see file | Settings for `npm run db:start` |

## Tests

```
npm test
```

Runs every test against a brand-new database it creates on
`TEST_DATABASE_URL`'s server, applies the migrations to, and drops at the
end; no existing database is touched. It needs PostgreSQL running. Three
live suites run only when their target answers and are skipped otherwise:

- `tests/scoring-live.test.ts` and `tests/seed-live.test.ts`: need the
  scoring service (`LIVE_SCORING_URL`, default `http://127.0.0.1:8000`);
- `tests/api-live.test.ts`: needs the app running with seed data (`APP_URL`,
  default `http://localhost:3000`); sends 30 bad requests across every route.

`npm run demo:rehearse` walks the demonstration path through the app's API
(see DEMO.md). `npm run typecheck` and `npm run build` check the code compiles.

## Deploying

What a hosted deployment needs:

1. **PostgreSQL** reachable at `DATABASE_URL`.
2. **The scoring service**, deployed separately as a Python web service from
   the repository root, with its trained `artifacts/` (they are not
   committed; build them as the root README describes). Point
   `SCORING_SERVICE_URL` at it. Keep it private to the app if you can.
3. **The app**, built with `npm ci && npm run build` and started with
   `npm run start:deploy`, which runs `prisma migrate deploy` before
   `next start`, so migrations run as part of every deploy. `next start`
   honours `PORT`. Set every variable from `.env.example`; `NEXTAUTH_URL`
   must be the public URL.
4. **A scheduler**: either a worker process running `npm run scheduler`, or a
   cron service calling `POST /api/cron/scoring` every minute with the
   `CRON_SECRET` bearer token.
5. **Persistent storage for evidence files** (`EVIDENCE_STORAGE_DIR`). The app
   writes uploads to local disk; on a platform with ephemeral disks, mount a
   volume, or replace `src/lib/evidence/storage.ts` with object storage
   (nothing else reads the disk).
6. Health check: `GET /api/health` (200 when the database answers).

Then seed (`npm run db:seed`, with the scoring service reachable) and follow
DEMO.md.

**Not done in this build:** no hosted deployment was made. It needs your
hosting account, database and secrets. Issue #19 stays open for that.

## Project layout

```
app/
  prisma/schema.prisma        data model; migrations/ include the state-machine trigger,
                              append-only decisions and the escrow-hold view
  prisma/seed.ts              demo data, scored by the real service
  scripts/                    local PostgreSQL, scheduler, run-all, demo rehearsal
  src/app/                    pages (admin/, agent/, client/) and API routes (api/)
  src/components/             UI; review/ is the review screen
  src/lib/activations/        state machine, submission, outcomes of each band
  src/lib/scoring/            scoring-service contract, client, payload, durable jobs
  src/lib/review/             queue, review detail, reviewer actions, review-screen copy
  src/lib/escrow/, payouts/   holds and balances; the payout authorisation boundary
  tests/                      Vitest suites
```

## Known limitations

- One activation is one customer sign-up, because that is what the scoring
  model scores; the design's "claims N sign-ups" always reads 1.
- There is no geo-IP lookup. A web submission's network region defaults to
  the GPS fix's region unless set in the simulated-device panel.
- Notifications are in-app only; no SMS or email is sent.
- Settlement (issue #14) is not built: approving records a payout
  authorisation and moves no money.
- First-week customer activity is entered by the client by hand; a real
  integration would receive it from the client's systems.
