# Ledgerfield

Ledgerfield manages commission payouts for independent sales agents. A client
business deposits money into escrow and publishes a job with a commission
structure; publishing locks the job's maximum liability. The platform assigns the job
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

### Database encoding: the database must be UTF8

Agents and clients type names, notes and evidence in any language, so the
database must be **UTF8**. A database in a single-byte encoding such as
WIN1252 (the default of a PostgreSQL cluster initialised on Windows with a
Windows locale) rejects every character outside its code page. The app, the
scheduler and the seed check the connected database when they start and
refuse to run, saying why, if it is not UTF8; `/api/health` reports it as
`"database": "not_utf8"`.

Create a UTF8 database with:

```
createdb -E UTF8 --template=template0 <name>
```

`template0` is needed because the default template may carry another
encoding. On a cluster whose locale is not UTF-8 (a Windows cluster with an
`English_..1252` locale, for example) PostgreSQL also needs a compatible
locale; add `--locale=C`:

```
createdb -E UTF8 --template=template0 --locale=C <name>
```

The local PostgreSQL from `npm run db:start` ships no `createdb` client, so
use the equivalent script, which runs against the server in `DATABASE_URL`
and only ever creates:

```
npm run db:create -- ledgerfield_utf8
```

Then point `DATABASE_URL` at the new database and run `npm run db:migrate`
and `npm run db:seed`. `npm run db:start` creates the databases it is asked
for as UTF8 when they do not exist yet, and initialises a brand-new cluster
as UTF8; it never changes an existing database. The test suite creates each
of its throwaway databases as UTF8 whatever the cluster's encoding.

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
`ScoringJob` table, and payment instructions are rows in `Disbursement` and
`FundingAttempt`. `npm run scheduler` polls for due rows every
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
| `CRON_SECRET` | (unset = disabled) | Guards `POST /api/cron/scoring` and `POST /api/cron/payments` |
| `MPESA_*` credentials | (unset = payments off) | See [M-Pesa](#m-pesa); set in the root `.env` |
| `MPESA_TIMEOUT_MS` | 30000 | Wait for Daraja before a send counts as unknown (assumption) |
| `MPESA_WHOLE_SHILLINGS_ONLY` | `true` | Refuse amounts with cents (assumption) |
| `MPESA_STK_MIN_CENTS`, `MPESA_STK_MAX_CENTS` | 100, 25000000 | STK limits, from Daraja's documentation |
| `MPESA_B2C_MIN_CENTS`, `MPESA_B2C_MAX_CENTS` | 1000, 25000000 | B2C limits, from Daraja's documentation |
| `MPESA_CALLBACK_ALLOWED_IPS` | (empty = off) | Optional source check, on top of the signed URL |
| `PAYMENT_RETRY_BASE_SECONDS`, `PAYMENT_MAX_SENDS` | 60, 6 | Payout retries, doubling (assumption) |
| `PAYMENT_RESULT_WAIT_SECONDS`, `PAYMENT_MAX_STATUS_QUERIES` | 900, 3 | When to ask Daraja, and how often (assumption) |
| `FUNDING_RETRY_BASE_SECONDS`, `FUNDING_MAX_SENDS` | 15, 3 | Funding retries, doubling (assumption) |
| `FUNDING_RESULT_WAIT_SECONDS`, `FUNDING_MAX_STATUS_QUERIES` | 180, 3 | The same for funding (assumption) |
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

## Money

- **Every amount is an integer number of Kenyan Shilling cents**, in columns
  named `...Cents` (rates in basis points, `...Bps`). `src/lib/money/` is the
  only place amounts are parsed, computed or formatted, using integer and
  string operations only. `npm run check:money` (run first by
  `npm run build`) fails if a Float or Decimal column could hold money.
- **Commission** for one approved submission is
  `floor(submission value x rate in bps / 10000) + flat amount`. It is
  computed and stored as a `Commission` record when the activation is
  approved, copying the job's structure, and the payout authorisation pays
  exactly that amount. Every computed amount on screen has a derivation line
  under it, and the APIs return it (`GET /api/admin/review/{id}`,
  `GET /api/client/escrow`).
- **Escrow belongs to the client.** `POST /api/client/escrow/fund` starts an
  M-Pesa payment, and only a verified callback credits it (see [M-Pesa](#m-pesa));
  publishing a job (`POST /api/client/jobs`) locks slots x commission and is
  refused with a 409 when the available balance falls short; closing it
  (`POST /api/client/jobs/{id}/close`) returns the unspent remainder. Balances
  are derived from deposits, locks and hold states, never stored.
- **Existing databases:** `npm run db:migrate` applies migration
  `20261029100000_money_in_cents`, which converts seeded data in place (each
  old flat payout becomes a structure that reproduces it to the cent) and
  checks every conversion as it runs.

## M-Pesa

Escrow is funded by STK Push and commissions are paid by B2C, through Daraja.
All of it is in `src/lib/payments/`.

- **Funding.** The client asks for an amount from a number on the Jobs page.
  That sends a prompt and moves no money. The balance changes only when a
  verified callback confirms the payment, and a database trigger refuses any
  deposit without a confirmed attempt behind it. Pending, confirmed and failed
  attempts are all listed on the same page.
- **Payout.** Approval records the commission and queues one B2C instruction in
  the same transaction, through the `PayoutAuthoriser` boundary. It makes no
  call to Daraja, so an outage cannot undo an approval. A worker sends it after
  the approval commits. The amount is the stored commission; cents become
  shillings only in `src/lib/payments/amount.ts`, exactly, and an amount that
  cannot be sent exactly is refused rather than rounded.
- **Whole shillings.** `MPESA_WHOLE_SHILLINGS_ONLY` defaults to true, so a
  commission with cents (the seed's KSh 279.99) fails visibly at approval. This
  is an assumption: the documentation only calls the amount "Numeric". Set it to
  false once a sandbox payment shows cents are paid exactly.

### Credentials

Set these in the `.env` at the repository root, which git ignores:
`MPESA_ENV`, `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`,
`MPESA_STK_SHORTCODE`, `MPESA_STK_PASSKEY`, `MPESA_B2C_SHORTCODE`,
`MPESA_B2C_INITIATOR_NAME`, `MPESA_B2C_SECURITY_CREDENTIAL` and
`MPESA_CALLBACK_BASE_URL`. The app and the scripts read the `MPESA_` names from
that file as well as `app/.env`; a value already set is never replaced. The test
suite never reads them: `vitest.config.ts` replaces them with fakes and points
Daraja at a closed port. Until they are all set the app runs, funding answers
503, and queued payouts wait without using up a retry.

### The callback URL, and tunnelling in development

Daraja reports results by calling this app, so it needs an address Daraja can
reach. **`localhost` will not work, and Daraja requires HTTPS.** Set
`MPESA_CALLBACK_BASE_URL` to the public HTTPS origin, with no path. Every
callback URL is built from it at the moment an instruction is sent; no host is
fixed anywhere else.

For local development, run a tunnel to the app. A Cloudflare quick tunnel needs
no account:

```sh
cloudflared tunnel --url http://localhost:3000
```

It prints an `https://<random>.trycloudflare.com` address. Put that in
`MPESA_CALLBACK_BASE_URL`, then start or restart the app. `npx localtunnel --port
3000` is an alternative. Daraja's documentation says ngrok addresses are usually
blocked.

**The address changes every time the tunnel restarts.** Update the variable and
restart the app each time. Daraja keeps the address it was given with each
instruction, so a result still on its way when the tunnel stops is lost. A
payout in that position is not resent: the worker asks Daraja for its status,
and the answer goes to the current address.

### How a callback is verified

Daraja does not sign its callbacks. Each instruction is therefore given its own
URL, `/api/payments/callback/<kind>/<reference>/<signature>`, where the signature
is an HMAC of the kind and reference under a key derived from
`MPESA_CONSUMER_SECRET`. A request with a wrong signature gets a 401 and is
neither read nor recorded. The route has no `mpesa` in its path and references
are hexadecimal because Daraja forbids words such as "mpesa", "exec" and "query"
in URLs.

`MPESA_CALLBACK_ALLOWED_IPS` adds an optional check of the source address. It is
empty by default because Safaricom's addresses are not in the Daraja
documentation, and it reads `X-Forwarded-For`, so it needs a proxy that sets that
header. Rotating the consumer secret invalidates the URLs of instructions still
in flight.

Each distinct result is applied once: repeat deliveries raise a counter on the
`PaymentCallback` row and change nothing else. A callback that contradicts a
settled record, or names no known reference, changes nothing and is listed under
**Needs attention** on the Payouts page.

### Retries, and why a payout is never sent twice

`npm run scheduler` also works this queue, as does `POST /api/cron/payments`
with `CRON_SECRET`. Funding is sent at once by the request; payouts wait for the
worker, so **no payout is sent unless one of those is running**.

| Daraja's answer | What happens to a payout |
|---|---|
| Accepted | `sent`; waits for the result |
| Could not be reached, 429, 503, or a documented busy or server error | `queued` again with doubling delay, same `OriginatorConversationID`; `failed` at the limit, raised to administrators |
| Refused for good | `failed` with Daraja's reason, raised to administrators |
| No answer, or anything unrecognised | `unconfirmed`: it may have arrived, so it is never sent again |
| Duplicate `OriginatorConversationID` | `unconfirmed`: Daraja already holds it |

An `unconfirmed` payout, or a `sent` one whose result is overdue, is resolved by
Daraja's Transaction Status query. If that settles nothing within the limit, it
is raised to administrators and stays unsent. A trigger stops any row Daraja may
hold from returning to `queued`.

### Capturing a real sandbox run

The evidence in `docs/chapter5/evidence/mpesa/` comes from `npm run sandbox:run`,
which refuses anything but the sandbox. It needs PostgreSQL, the scoring service
and a tunnel, and a real Safaricom line in `MPESA_SANDBOX_PAYER_MSISDN`: Daraja's
test number has no handset, so its prompt ends in `1037 No response from user`.

```sh
npm run db:create -- ledgerfield_sandbox
export DATABASE_URL=postgresql://ledgerfield:ledgerfield@127.0.0.1:5433/ledgerfield_sandbox
export MPESA_CAPTURE_DIR=$PWD/../docs/chapter5/evidence/mpesa/run-YYYY-MM-DD
npm run db:migrate && npm run build
npm start &
npm run sandbox:run        # then enter the PIN when the phone prompts
```

`MPESA_CAPTURE_DIR` must be set for both the app and the script, because the app
receives the callbacks. Everything is redacted before it is written. With
`--b2c-leg` the script funds by a simulated callback and runs the real B2C leg
alone; its summary says so, and it is not the end-to-end run.

## Evidence fields

- **Each job has its own evidence fields**, set by the client when posting
  (and editable later): an ordered list of fields, each with a label, a type
  (text, number, date, choice from a list, phone number, photo), whether it
  is mandatory, and the expected format. They are stored as JSON
  (`EvidenceConfig.fields`), so a job's field set needs no schema change.
- **Versions.** Every edit adds the next version; versions are never changed.
  A submission is validated against the version in force when it is made
  and records it (`Activation.evidenceConfigId`), so an edit never
  invalidates past submissions, and the review screen labels them with their
  own version's labels. A form opened before an edit is refused with a 409
  so the agent reloads it.
- **The capture form is built from the fields**: the platform's own fields
  (customer number, SIM date, capture method, proof, note;
  `src/lib/evidence/platform.ts`) and then the job's. Both are validated in
  one pass on the server; the form runs the same rules in the browser first.
- **Two layers.** The platform's fields are the observable inputs the fraud
  model reads. A client's fields are stored in `Activation.evidencePayload`
  and are never sent to the scoring service; `tests/layer-boundary.test.ts`
  fails if any of their values can reach a scoring request.
- **Deadline.** Every job published now has one (FR-04); after it the job
  takes no new assignments, acceptances or submissions.
- **APIs:** `GET/POST /api/client/jobs/{id}/evidence-config` (current version
  and history; save a new version), `GET /api/agent/assignments/{id}/evidence-form`
  (the form definition and the version id a submission must send back).

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request: the app's
Vitest suite against a PostgreSQL container, the production build (with the
money-column check) and the typecheck; and the Python suite, after
regenerating the dataset and the serving artifacts, which are not committed.

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
  src/lib/money/              integer cents, the commission calculation, the money-column check
  src/lib/evidence/           field definitions and validation, platform fields, configuration versions
  src/lib/escrow/, payouts/   client and job escrow, holds; commission records; the payout boundary
  src/lib/payments/           Daraja client, funding, disbursement queue, callbacks, redaction
  tests/                      Vitest suites
```

## Known limitations

- One activation is one customer sign-up, because that is what the scoring
  model scores; the design's "claims N sign-ups" always reads 1.
- There is no geo-IP lookup. A web submission's network region defaults to
  the GPS fix's region unless set in the simulated-device panel.
- Notifications are in-app only; no SMS or email is sent.
- The real sandbox run is not complete: no successful STK Push or B2C payment
  has been observed. See `docs/chapter5/evidence/mpesa/README.md`.
- An administrator can see a failed payout but cannot retry it from the app. A
  payout stopped by a long outage needs its cause fixed and a manual payment,
  or a new action to requeue it, which this build does not add.
- A job whose commission has cents can still be published, and its payouts fail
  at approval while `MPESA_WHOLE_SHILLINGS_ONLY` is true. Publishing is left
  unaware of Daraja on purpose.
- Payouts authorised through the old no-op have no disbursement and were not
  queued. Nothing was paid for them.
- Funding that M-Pesa's status check reports as paid, but whose callback never
  arrived, is not credited. It is raised to an administrator instead.
- First-week customer activity is entered by the client by hand; a real
  integration would receive it from the client's systems.
- One money row holds at most KSh 21,474,836.47 (a PostgreSQL INTEGER of
  cents), so a job's maximum liability is capped there; publication above it
  is refused with a clear message.
- Closing a job does not cancel its open assignments: money reserved or held
  for them stays committed until each activation is decided.
- The app refuses a database that is not UTF8 (see "Database encoding"). A
  development database created before that check, in a WIN1252 cluster, has
  to be replaced by a UTF8 one; the app does not convert it.
- Photo capture time is the file's last-modified time and photo location is
  the device's fix when the photo is added; EXIF is not read. The
  submission's own timestamp is when the server received it.
- Evidence fields are not shown to the client with the outcome; the client
  sees outcomes and reasons, as before.
