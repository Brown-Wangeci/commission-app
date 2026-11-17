# Ledgerfield runbook (local)

The local setup is the fallback for a live demonstration: everything runs on
this machine, with no hosted service involved. Hosted deployment is in
[DEPLOY.md](DEPLOY.md); the demonstration script itself is in
[app/DEMO.md](../app/DEMO.md).

## One-time setup

As in [app/README.md](../app/README.md), "First-time setup": `npm ci` in
`app/`, `app/.env` copied from `app/.env.example`, the Python environment in
`.venv` at the repository root, and the model artifacts built.

## Start and stop

From the repository root:

| | Windows (PowerShell) | macOS, Linux |
|---|---|---|
| Start | `scripts\demo-start.ps1` | `scripts/demo-start.sh` |
| Start and reset the demo data | `scripts\demo-start.ps1 -Seed` | `scripts/demo-start.sh --seed` |
| Also run the scheduler | add `-Scheduler` | add `--scheduler` |
| Dev server instead of the production build | add `-Dev` | add `--dev` |
| Stop | `scripts\demo-stop.ps1` | `scripts/demo-stop.sh` |

Start runs local PostgreSQL (`app/.pgdata`, port 5433), applies any pending
migrations, starts the scoring service from `.venv` and waits until it
reports its models loaded, optionally seeds, then starts the app on
http://localhost:3000 and waits until `/api/health` answers. The first start
also makes the production build. Each part logs to `app/.demo/<part>.log`.
A part that is already running (PostgreSQL on its port, or a scoring service
that answers) is used as it is and is left running by stop.

Stop shuts PostgreSQL down cleanly (`pg_ctl stop -m fast`), then ends
everything else that start launched.

Leave out `-Scheduler` for Part 1 of the demonstration: one seeded case is
waiting for an automatic retry, and the scheduler would score it.

## Seeded logins

Every account's password is `ledgerfield-demo`. These are made by the seed
on a demonstration database and are not secret.

| Role | Email | Who |
|---|---|---|
| admin (reviewer) | `reviewer@ledgerfield.test` | Amina Otieno |
| admin | `reviewer2@ledgerfield.test` | David Mwangi |
| client | `client@ledgerfield.test` | Joyce Njeri, Mwanga Mobile |
| client | `client2@ledgerfield.test` | Peter Ochieng, Tujenge Pesa |
| agent | `grace@ledgerfield.test` | Grace Wanjiku, clean record |
| agent | `mercy@ledgerfield.test`, `samuel@ledgerfield.test`, `faith@`, `kevin@`, `brian@` | other agents |

## Forcing a quick T7 decision

A T7 (hold-close) decision normally comes seven days after submission. Three
ways to see one now:

1. **Force it on one activation.** Sign in as an admin. On the dashboard
   (`/admin`), the **Hold window** tab lists held activations; press
   **Force T7 now** beside one. It is scored at once with the T7
   model and the band is applied. It runs the same durable job as the
   scheduler, so it cannot be scored twice.
2. **Shorten the hold window.** Set `HOLD_WINDOW_SECONDS=120` in `app/.env`,
   then start with `-Scheduler`. A new submission is scored at T7 by the
   scheduler about two minutes later. The hosted app uses 300 with the
   scoring cron job.
3. **Run due jobs by hand.** **Run due scoring now**, in the same panel,
   runs whatever is due, as one scheduler poll would.

## Reset the hosted demo data

Use this before a live demonstration on the hosted app, so that Part 1 of
app/DEMO.md shows the seeded cases as the seed left them.

**Allow 45 minutes, and start well before the demonstration.** The hosted
seed is run from a laptop against Neon in Frankfurt. From Nairobi each query
costs about 190 ms, and the seed makes thousands. On 2026-11-15, the run
that completed took 41 min 52 s. Two earlier runs lost their database
connection after 27 to 29 minutes and had to be started again. The local
seed takes about half a minute.

### 1. Pause the jobs

In cron-job.org, **pause** the scoring, payments and anchoring jobs. Leave
the scoring keep-warm (`/health`) job running: the seed needs the scoring
service awake. While the jobs are paused nothing is lost. Every queue is a
table, and the jobs pick up where they left off.

### 2. Re-seed

From `app/` (PowerShell or sh; the commands are the same):

```sh
vercel env pull .env.hosted --environment=production --yes
curl https://ledgerfield-scoring.onrender.com/health
node node_modules/tsx/dist/cli.mjs scripts/seed-hosted.ts
```

- Repeat the `curl` until it shows `"loaded": true`. In PowerShell, write
  `curl.exe`.
- `.env.hosted` is gitignored and never loaded by Next.js or Prisma on their
  own. Always pull to that name: a bare `vercel env pull` writes
  `.env.local`, which the local app would then read.
- `scripts/seed-hosted.ts` reads `.env.hosted` and refuses to start if the
  pull lacks the Blob token or is not from Vercel. It then seeds through the
  direct (unpooled) URL with a single connection, and with a 30 s
  transaction timeout instead of Prisma's 5 s. Both settings exist only
  because of the distance. They change how the seed connects, never what it
  writes.
- The seed's next line must be `Evidence storage: blob (emptied).`
- It ends with "Every named case landed where intended." All 14 named cases
  landed on 2026-11-15.
- If it stops with `P1017 Server has closed the connection` or a timeout,
  run the same command again. The seed starts by emptying the tables, so a
  half-finished run leaves nothing behind that matters, and the paused jobs
  do not act on it.
- The seed empties every table except the migrations and the transition
  rules, then rebuilds the demonstration data, scoring each submission
  through the live scoring service.

### 3. If the seed refuses: accounts it did not create

The seed stops with "This database has N account(s) that the seed did not
create" when someone signed up (`/signup`) during rehearsal or
verification. The hosted verification used only the seeded accounts, so
this happens only if a new account was created by hand. Such an account
cannot simply be deleted: audit events, decisions and payments that
reference it are append-only. Rebuild the schema instead, then seed:

```sh
node --env-file=.env.hosted node_modules/tsx/dist/cli.mjs scripts/prisma-env.ts migrate reset --force --skip-seed
node node_modules/tsx/dist/cli.mjs scripts/seed-hosted.ts
```

- `migrate reset` **drops everything in Neon's `public` schema**, then
  re-applies every migration through the unpooled URL. That includes the
  triggers and views.
- Before running it, check that `.env.hosted` came from the production
  pull above. It never touches `app/.env` or the local database.
- `--force` skips Prisma's confirmation prompt, so read the command twice.
- Run this yourself. Prisma refuses `migrate reset` when an AI agent runs
  it, unless you give explicit consent. For that reason this step has not
  been tried on this project, locally or on Neon. The two commands above are
  the standard Prisma reset, then the same seed as in step 2.

### 4. Turn the jobs back on during the demo

| When | Re-enable | Why then |
|---|---|---|
| Any time after the seed | Anchoring | It only anchors. Its first run anchors the new chain from sequence 1, and an "Anchored" event appears in the audit log. |
| Start of Part 2, before the live submission | Scoring | Its first run scores the seeded "submitted (T0 queued)" case at T0, and retries the "could not be scored" one (advisory, so its state does not change). Both change what Part 1 shows, so keep it off until Part 1 is over. The seeded held activations are not touched: the seed gives them a seven-day hold window, so they fall due days later. The live submission's T7 decision arrives at the first run after its 300 s window, so within about six minutes. |
| When Part 2 reaches the payout | Payments | Every release queues a B2C instruction, and this job sends it to the Daraja sandbox. |

### What happens to anchored batches after a re-seed

The seed empties `AuditEvent`, `AuditChain` and `AuditAnchor` along with
everything else. TRUNCATE does not fire the row-level append-only and
no-delete triggers, which is why it can.

- **On chain:** every root anchored before the re-seed stays in the
  contract for good, and its transaction stays on Polygonscan.
- **In the app:** the events those roots cover are gone from Neon. The audit
  page and `npm run audit:verify` see only the new chain and can no longer
  check the old roots against data.
- **New batches:** the new chain starts again at sequence 1. The next
  anchoring run sends it as a new batch to the same contract. Its root is
  new, so the contract accepts it; the contract refuses only a root it
  already holds.
- **Capture first:** save any anchoring evidence (transaction, verification
  result) **before** re-seeding.

The seed also deletes every photo under `evidence/` in the Blob store,
including photos from verification submissions.

## Common failures

| Symptom | Cause and fix |
|---|---|
| Start says `app/.env.local sets DATABASE_...` | The Vercel CLI (`vercel link`, `env pull` without a file name, `blob create-store`) wrote hosted settings into `app/.env.local`, which Next.js reads ahead of `app/.env`. Delete those lines; keep only `VERCEL_OIDC_TOKEN` if present. Always pull to a named file: `vercel env pull .env.hosted`. |
| `port 3000` or `8000` already in use | Another copy is running. Run stop, or end the other process. |
| The app refuses to start: database not UTF8 | See app/README.md, "Database encoding". `npm run db:create -- <name>` makes a UTF8 database. |
| A submission lands in review as "could not be scored" | The scoring service was down or slow: three attempts of 15 s each, then review. That is the designed fallback. Check `app/.demo/scoring.log`, or, hosted, wake Render with `GET /health` and wait for `"loaded": true`. |
| `Environment variable not found: DATABASE_URL_UNPOOLED` | A bare `npx prisma migrate ...` was run. Use `npm run db:migrate` or `npm run db:reset`; they set it from `DATABASE_URL`. |
| A page fails with a missing table or column | Migrations are behind. Start runs them; otherwise `npm run db:migrate` in `app/`. |
| The seed says the scoring service is not answering | Start the scoring service first (start does), or wake the hosted one. The seed never invents a score. |
| The seed refuses to clear the database | It holds accounts the seed did not make. Point `DATABASE_URL` at a demonstration database. |
| Cron route answers 404 | `CRON_SECRET` is not set where the app runs. |
| Cron route answers 401 | The header is missing or wrong: `Authorization: Bearer <CRON_SECRET>`. |
| Anchoring summary says `skipped: true` | A Polygon setting is missing or malformed. The key must be `0x` and 64 hex characters. |
| Hosted photo upload fails with 413 | The request was larger than Vercel's 4.5 MB limit. Use a smaller photo. |
| M-Pesa callbacks never arrive locally | Daraja cannot reach localhost. It needs an HTTPS tunnel, with `MPESA_CALLBACK_BASE_URL` set to it (app/README.md, "M-Pesa"). |
