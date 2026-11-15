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
   (`/admin`), the hold-window panel lists held activations; press
   **Force T7 now** beside one. It is scored at once with the T7
   model and the band is applied. It runs the same durable job as the
   scheduler, so it cannot be scored twice.
2. **Shorten the hold window.** Set `HOLD_WINDOW_SECONDS=120` in `app/.env`,
   then start with `-Scheduler`. A new submission is scored at T7 by the
   scheduler about two minutes later. The hosted app uses 300 with the
   scoring cron job.
3. **Run due jobs by hand.** **Run due scoring now**, in the same panel,
   runs whatever is due, as one scheduler poll would.

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
