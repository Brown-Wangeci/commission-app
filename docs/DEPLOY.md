# Deploying Ledgerfield (hosted)

How the hosted system is put together, every setting it reads, the order to
bring it up in, the scheduled jobs, and how to roll back. The local setup,
which is the demo fallback, is in [RUNBOOK.md](RUNBOOK.md).

## Services

| Part | Service and plan | Region | Notes |
|---|---|---|---|
| App (Next.js) | Vercel, Hobby, project `commission-app`, root directory `app` | fra1 (`app/vercel.json`) | Builds and deploys every push to `main`; previews for pull requests. Fluid Compute on: 300 s function limit. |
| Database | Neon, `commission-neon-db`, via the Vercel integration | eu-central-1 | The integration sets the `DATABASE_*` variables. |
| Evidence files | Vercel Blob, store `ledgerfield-evidence`, **private** | fra1 | Connected to Production and Preview. |
| Scoring service | Render, free web service `ledgerfield-scoring` | Frankfurt | Recorded in `render.yaml`; spins down when idle. |
| Audit anchoring | Polygon Amoy testnet (chain 80002), contract `AuditAnchor` | n/a | Deployed once with `npm run contract:deploy`. |
| Payments | Safaricom Daraja sandbox | n/a | Calls back to the Vercel origin. |
| Scheduler | cron-job.org | n/a | Calls the three cron routes and keeps the scoring service awake. |

Functions run in fra1 so that each database query stays inside Frankfurt;
the project default was iad1 (Washington).

## Settings

Set in **Vercel > Project > Settings > Environment Variables** unless the
"Set by" column says otherwise. Names only: no value is ever committed.
"Both" means Production and Preview.

### Required

| Name | Set by | Environments | What it is |
|---|---|---|---|
| `DATABASE_URL` | Neon integration | all | Pooled connection (`-pooler` host). The app connects with this. |
| `DATABASE_URL_UNPOOLED` | Neon integration | all | Direct connection. Prisma Migrate uses it (`directUrl`). |
| `BLOB_READ_WRITE_TOKEN` | Blob store connection | both | Read by the Blob SDK. The store must be private. |
| `NEXTAUTH_SECRET` | you | both | Session signing key. |
| `NEXTAUTH_URL` | you | Production only | The production origin. Leave unset for Preview: next-auth uses `VERCEL_URL` there. |
| `SCORING_SERVICE_URL` | you | both | `https://ledgerfield-scoring.onrender.com` |
| `CRON_SECRET` | you | both | Bearer token for the cron routes. Unset means the routes answer 404. |
| `MSISDN_HASH_SALT` | you | both | At least 16 characters. Changing it breaks repeat-number detection. |
| `HOLD_WINDOW_SECONDS` | you | both | 300 for the demonstration (604800, seven days, in production use). |
| `MPESA_ENV` | you | both | `sandbox` |
| `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET` | you | both | Daraja app credentials. |
| `MPESA_STK_SHORTCODE`, `MPESA_STK_PASSKEY` | you | both | STK Push (funding). |
| `MPESA_B2C_SHORTCODE`, `MPESA_B2C_INITIATOR_NAME`, `MPESA_B2C_SECURITY_CREDENTIAL` | you | both | B2C (payouts). |
| `MPESA_CALLBACK_BASE_URL` | you | Production only | The production origin, `https://` and no path. Every callback URL is built from it. |
| `POLYGON_RPC_URL` | you | both | Amoy RPC endpoint. Treated as secret. |
| `POLYGON_CHAIN_ID` | you | both | `80002` |
| `POLYGON_PRIVATE_KEY` | you | both | The funded Amoy wallet's key, `0x` and 64 hex characters. |
| `POLYGON_ANCHOR_CONTRACT_ADDRESS` | you, after step 6 below | both | The deployed `AuditAnchor` address. |

### Optional (defaults apply when unset)

All are in `app/.env.example` with their defaults and reasons. The ones that
matter on Vercel:

| Name | Default | Why it matters hosted |
|---|---|---|
| `SCORING_TIMEOUT_MS`, `SCORING_IMMEDIATE_ATTEMPTS`, `SCORING_IMMEDIATE_BACKOFF_MS` | 15000, 3, 500 | Worst case for one scoring run is 46.5 s. After that the activation goes to review as "could not be scored". It never hangs and is never released unscored. |
| `CRON_TIME_BUDGET_SECONDS` | 240 | A cron request starts no new unit of work after this. Must stay below the 300 s function limit. |
| `EVIDENCE_STORAGE` | blob on Vercel, disk elsewhere | Set it only to force one backend. |
| `EVIDENCE_MAX_BYTES` | 8000000 | Vercel also caps a whole request at 4.5 MB, so larger uploads are refused by the platform with 413. |
| `ANCHOR_INTERVAL_SECONDS` | 3600 | How often a new anchoring batch is cut. |

### Set but not read by the deployed app

- `MPESA_SANDBOX_PAYER_MSISDN`, `MPESA_SANDBOX_PAYOUT_MSISDN`: read only by
  `app/scripts/sandbox-run.ts` on a developer machine.
- `DATABASE_PG*`, `DATABASE_POSTGRES_*`, `DATABASE_NEON_PROJECT_ID`: extras
  from the Neon integration.

### Local only (never set in Vercel)

`TEST_DATABASE_URL`, `LOCAL_PG_*`, `SCORING_PYTHON`, `EVIDENCE_STORAGE_DIR`,
`SCHEDULER_INTERVAL_SECONDS`, `MPESA_CAPTURE_DIR`, and the test-only
`LIVE_SCORING_URL`, `APP_URL`, `LIVE_CHAIN_RPC_URL`.

## Deploy order

1. **Scoring service.** It must already be live, because the seed scores
   through it. Its build installs the Python requirements, then downloads
   the serving artifacts from the GitHub release `scoring-artifacts-v1`. It
   checks them against `artifacts/scoring-artifacts-v1.tar.gz.sha256` and
   fails on a mismatch (`render.yaml`). It never retrains: a Linux rebuild
   gives a different model. Check
   `GET https://ledgerfield-scoring.onrender.com/health`, which should show
   `"loaded": true`. A free instance that has been idle takes a while to
   answer the first request.
2. **Database, Blob store and variables.** Attach Neon, create the private
   Blob store, set the variables above.
3. **Merge to `main`.** Vercel builds with `npm run build` (money column
   check, `prisma generate`, `next build`). The build does not touch the
   database and needs no local PostgreSQL. `embedded-postgres` is a
   devDependency that nothing in the build or the runtime imports.
4. **Migrate Neon** from a developer machine, using the direct URL:

   ```sh
   cd app
   vercel env pull .env.hosted --environment=production --yes
   # .env.hosted is gitignored, and Next.js and Prisma never load it by themselves.
   node --env-file=.env.hosted node_modules/tsx/dist/cli.mjs scripts/prisma-env.ts migrate deploy
   ```

   `scripts/prisma-env.ts` passes both `DATABASE_URL` (pooled) and
   `DATABASE_URL_UNPOOLED` (direct) through, and Prisma Migrate uses the
   direct one. Migrations create the state-machine trigger, the
   append-only and hash-chain triggers, and the escrow views.
5. **Seed** (once, or to reset the demonstration). Wake the scoring service
   first, then run, from `app/`:

   ```sh
   node --env-file=.env.hosted node_modules/tsx/dist/cli.mjs prisma/seed.ts
   ```

   `vercel env pull` writes `VERCEL="1"` into `.env.hosted`, so the seed
   stores its photos in the Blob store, as the hosted app does. It prints
   `Evidence storage: blob (emptied).`; stop it if that line says `disk`.
   The pull must have been made after the Blob store was connected, so that
   it includes `BLOB_READ_WRITE_TOKEN`. The seed refuses to clear a database
   holding accounts it did not create.
6. **Deploy the anchoring contract** once, then set
   `POLYGON_ANCHOR_CONTRACT_ADDRESS` in Vercel and redeploy:

   ```sh
   node --env-file=.env.hosted node_modules/tsx/dist/cli.mjs scripts/deploy-anchor.ts --no-env-write
   ```

   `--no-env-write` stops it writing the address into a local root `.env`.
7. **Create the cron jobs** (below).

A redeploy is needed after any variable change: Vercel reads variables at
build and start.

## Scheduled jobs (cron-job.org)

Every cron route is a **POST** and needs the header
`Authorization: Bearer <CRON_SECRET>`. Without the header the answer is 401;
when `CRON_SECRET` is unset, 404. Each run stops starting new work at
`CRON_TIME_BUDGET_SECONDS` and leaves the rest due for the next run. A
successful run answers 200 with a JSON `summary`.

| Job | Method and URL | Suggested interval | Does |
|---|---|---|---|
| Scoring | `POST <origin>/api/cron/scoring` | every minute | T7 at hold-close, and retries after scoring failures. |
| Payments | `POST <origin>/api/cron/payments` | every minute | B2C sends, retries, status checks, and funding checks. |
| Anchoring | `POST <origin>/api/cron/anchoring` | every 5 minutes | Cuts a batch when `ANCHOR_INTERVAL_SECONDS` has passed, and confirms receipts. |
| Keep-warm | `GET https://ledgerfield-scoring.onrender.com/health` | every 10 minutes | Keeps the free scoring instance from spinning down. |

`<origin>` is the production URL. With `HOLD_WINDOW_SECONDS=300`, a T7
decision arrives at the first scoring run after the five minutes are up.

The seed leaves one case ("could not be scored") waiting for an automatic
retry. The scoring cron will retry it. A retry on a case a reviewer already
owns is stored as advisory and never changes its state.

## Evidence files

Uploads go through `app/src/lib/evidence/storage.ts`, which picks a backend:
local disk under `EVIDENCE_STORAGE_DIR` for development and tests, and the
private Blob store on Vercel. The path stored on each `EvidenceItem` row is
the same for both. A photo is served only through the authorised
`/api/evidence/[id]` route, which reads it from Blob with the store token. A
private blob has no public URL.

## HTTPS (IR-09)

Vercel answers plain HTTP with a redirect to HTTPS at its edge. The app adds
`Strict-Transport-Security: max-age=63072000; includeSubDomains` to every
response, plus the same redirect for any proxy that forwards plain HTTP with
`X-Forwarded-Proto: http` (`app/src/lib/http/https-policy.ts`).

## Rollback

| Part | How |
|---|---|
| App | Vercel > Deployments > a previous Ready deployment > **Instant Rollback** (or `vercel rollback`). Migrations only go forward, so roll back only to a deployment whose code matches the current schema. |
| Database | Neon > the project > **Restore** (point in time, within the plan's history window), or restore to a new branch and point `DATABASE_URL` and `DATABASE_URL_UNPOOLED` at it. |
| Evidence | Blob objects are written once per path. Deleting the store loses every photo, so do not. |
| Scoring service | Render > `ledgerfield-scoring` > Events > a previous deploy > **Rollback**. |
| Contract | It cannot be changed. Deploy a new one and change `POLYGON_ANCHOR_CONTRACT_ADDRESS`; earlier anchors stay verifiable on the old address. |
| Scheduler | Pause the jobs in cron-job.org. Nothing is lost while paused: every queue is a table. |
| Fall back to local | `scripts/demo-start` (see RUNBOOK.md). |
