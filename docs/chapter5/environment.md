# Environment

The exact hardware and software this project's evidence was measured and
captured on, and the hosted system it was also run on.

**A hosted deployment exists** (since 2026-11-15): the app on Vercel (region
fra1), the database on Neon, evidence photos on Vercel Blob, the scoring
service on Render, audit anchoring on Polygon Amoy, payments against the
Safaricom Daraja sandbox, and the scheduler on cron-job.org. How it is built
and configured is in `docs/DEPLOY.md`; what was measured on it is in
`evidence/hosted/`, and the services are tabulated under "Hosted deployment"
below. Hosted evidence is kept separately and is not mixed into the local
figures.

The rest of this file describes the local environment. Every local number in
this chapter -- the load test (NFR-01), the scoring latency measurement
(NFR-02), the local screenshots, the logs, and every local test run -- comes
from this one developer machine. Where NFR-02 asks for figures "on the
deployment hardware", the local latency figures were measured on the same
machine that ran the local setup, not on the hosted servers.

## Hardware and deployment

| Item | Value | Purpose | Why this |
|---|---|---|---|
| CPU | 13th Gen Intel Core i7-1365U, 10 cores (12 logical) | Runs the app, the scoring service, PostgreSQL and the browser for screenshots, all at once during measurement | The only machine available to this project; a laptop-class mobile CPU, not server-class, which the NFR-01/NFR-02 reports state plainly |
| RAM | 16 GB | Headroom for Node, Python/XGBoost, PostgreSQL and a browser concurrently | As installed; not chosen for this project |
| OS | Windows 11 Pro, build 26200 | Host platform for every tool below | The developer's own machine |
| Deployment | None for the measurements in this table; a hosted deployment exists since 2026-11-15 (see "Hosted deployment" below) | N/A | Every local measurement below is against `npm start` / `next start` on this machine, not a server. Hosted measurements are kept separately in evidence/hosted/ |
| Database host | Embedded PostgreSQL, 127.0.0.1:5433 | The app's own data store | `embedded-postgres` (see software table) starts a real PostgreSQL server locally with no separate installation, so the schema, triggers and constraints under test are the real ones, not a stand-in |
| Scoring service host | Uvicorn, 127.0.0.1:8000, single process | Serves the fraud model over HTTP exactly as the app calls it | Matches `src/serve/app.py`; one process, no load balancer, because the local setup has nothing to put one in front of |
| Network | Loopback only (127.0.0.1) | Every measured call in this chapter | No measurement here includes real network latency, mobile data conditions, or a reverse proxy; NFR-01's own rationale (agents on mobile data) is therefore not reproduced by this measurement, which is a gap recorded in gaps.md |

## Hosted deployment (added 2026-11-16)

The system also runs hosted. The local setup above is still the demonstration
fallback, and every local measurement in this chapter is unchanged. The
hosted measurements are in `evidence/hosted/`, labelled as hosted, and are
not mixed into the local tables.

| Part | Service and plan | Region | Notes |
|---|---|---|---|
| App | Vercel, Hobby (free), project `commission-app`, root `app` | fra1 (`app/vercel.json`) | Fluid Compute: 300 s function limit, set in the route files; 4.5 MB request body limit |
| Database | Neon (free), PostgreSQL 18.7, via the Vercel integration | eu-central-1 (Frankfurt) | Pooled URL for the app, direct URL for migrations and the seed |
| Evidence photos | Vercel Blob, private store | fra1 | Served only through the authorised `/api/evidence/[id]` route |
| Scoring service | Render, free web service | Frankfurt | Python 3.14.3 (from its build log); serves the published artifacts, checked by SHA-256; spins down when idle |
| Audit anchoring | Polygon Amoy testnet, chain 80002 | n/a | One batch of 709 events cost 0.001478 POL in fees |
| Payments | Safaricom Daraja sandbox | n/a | Callbacks go to the Vercel origin |
| Scheduler | cron-job.org (free) | Germany (source of the requests) | Scoring and payments every minute, anchoring every 5 minutes |
| Client for measurements | The developer laptop in the table above, in Nairobi | | About 0.23 s to Frankfurt (median of 30 `GET /health` calls) |

Limits that shaped the work, as observed or read from the providers'
documentation during this work (they change; check the provider before
relying on them):

- **Vercel Hobby.** 300 s per function, 4.5 MB per request body (larger gives
  413), so a cron request stops starting new work after 240 s
  (`CRON_TIME_BUDGET_SECONDS`) and a photo over about 4.5 MB is refused.
  Request logs older than 12 hours need a paid plan (observed: HTTP 402 for
  older records). The firewall was not configured and denied nothing.
- **Vercel Blob (Hobby).** 1 GB of storage and a monthly allowance of
  operations and transfer, after which access is blocked for a period. The
  demo uses a small fraction.
- **Neon free.** A remote seed from Nairobi takes about 42 minutes at roughly
  190 ms per query, and two earlier attempts lost their connection part-way
  (`evidence/hosted/seed/`).
- **Render free.** The instance spins down when idle and takes a while to
  answer the first request afterwards.
- **Daraja sandbox.** Answered a status query with HTTP 429 and with
  `500.001.1001` ("being processed"); completed one STK payment about 20 hours
  late and reversed it; did not deliver the callbacks of 15 November
  (`evidence/hosted/mpesa/`).
- **Polygon Amoy.** Fees are paid from a funded testnet wallet.

What the hosted measurements do and do not establish is stated beside each
measurement. In short: one client machine, one internet connection, free
plans, a small demo database, and no mobile-data conditions.

## Software

| Component | Version | Purpose | Why this version |
|---|---|---|---|
| Node.js | 24.14.0 | Runtime for the Next.js app and every `tsx` script | Installed on the measurement machine; not pinned by this project beyond `package.json`'s own dependency versions |
| npm | 11.11.1 | Package manager for `app/` | Ships with the Node.js installation above |
| Next.js | 15.5.28 | The application framework (App Router, API routes) | Chosen at project start for integrated server-side routing, middleware and React 19 support |
| React / React DOM | 19.1.10 | UI rendering | Required by the chosen Next.js major version |
| TypeScript | 5.9.3 | Static typing across the application | Project-wide type safety; pinned in `app/package.json` |
| Prisma (client and CLI) | 6.19.3 | Database schema, migrations and typed queries | Hand-written migrations with self-checks are layered on top (see BUILD_LOG.md); chosen for migration-diff tooling and generated types |
| embedded-postgres | 17.6.0-beta.15 | Runs a real local PostgreSQL 17 server for development, tests and this chapter's measurements, with no separate install | Lets `npm run db:start` and the test suite run a genuine PostgreSQL instance (triggers, constraints, views) without requiring a system-wide installation |
| NextAuth | 4.24.15 | Session-based authentication and role routing | Established at project start; integrates with the Next.js middleware used for route protection |
| zod | 3.25.76 | Request and config validation | Used throughout the API layer for schema validation with typed output |
| bcryptjs | 2.4.3 | Password hashing (NFR-05) | Pure-JavaScript bcrypt, cost factor 10, avoiding a native build dependency |
| Vitest | 3.2.4 | The application test suite | Fast, native ESM/TypeScript support, used for all 421 app-level tests (383 run in CI; 38 need a live service, see below) |
| viem | 2.57.7 | The blockchain client (reads and writes the audit-anchor contract) | Pinned at least two weeks old per this session's own versioning rule; typed, actively maintained Ethereum/EVM client |
| solc (solc-js) | 0.8.37 | Compiles `contracts/AuditAnchor.sol` | Pinned, reproducible compilation (a test recompiles and checks the committed artifact matches byte for byte); targets the `paris` EVM version so the bytecode runs on any current EVM chain |
| Anvil (Foundry) | 1.8.6 | Local EVM node for the blockchain anchoring evidence and the live chain test | Downloaded via the GitHub CLI and checked against Foundry's published SHA-256 before use; no funded Polygon Amoy wallet was available, so this stands in as the project's documented fallback (see `docs/chapter5/evidence/blockchain/README.md`) |
| @playwright/test | 1.64.1 | Browser automation for the Chapter 5 screenshots | Pinned at least two weeks old; drives a real Chromium browser against the real running app, rather than hand-captured images |
| Python | 3.14.3 | The ML pipeline, the scoring service, and this chapter's measurement scripts | As recorded at the top of `requirements.txt` since Phase 3 |
| numpy / pandas / scipy | 2.5.3 / 3.0.5 / 1.18.1 | Data generation and feature engineering | Per `requirements.txt` |
| scikit-learn | 1.9.1 | Metrics, isotonic calibration | Per `requirements.txt` |
| XGBoost | 3.4.1 | The fraud classifier itself | Per `requirements.txt` |
| imbalanced-learn | 0.14.2 | SMOTE / SMOTENC resampling (training split only, DR-04) | Per `requirements.txt` |
| SHAP | 0.52.0 | Feature attribution (FR-14) | Per `requirements.txt` |
| FastAPI / uvicorn / pydantic | 0.141.1 / 0.53.0 / 2.13.5 | The inference service (Phase 7) | Per `requirements.txt`; pydantic's `extra="forbid"` is what rejects malformed requests in IR-06's contract tests |
| pytest | 9.1.1 | The ML test suite | Per `requirements.txt`; used for all 162 committed Python tests |
| httpx | 0.28.1 | The scoring-latency measurement script's real HTTP client | Already a transitive dependency (FastAPI's recommended test client); reused here to make a genuine network round trip rather than an in-process call |

## Test suite results (CI, not this machine)

The counts below are from the project's own GitHub Actions CI
(`.github/workflows/ci.yml`), not a local run, on branch `accrue-restyle`
at commit `976b5ef` (PR #79), 2026-11-11: the `push` run 43040371977 and the
`pull_request` run 43040381579, which report identical counts. CI runs on
`ubuntu-latest` with no live app, scoring service, or blockchain node
available, so every test that needs one skips itself (each file's own
`describe.runIf(up)` / `describe.runIf(live)` guard, not a CI-specific
flag).

| Suite | Passed | Skipped | Failed |
|---|---|---|---|
| pytest (`ML tests (pytest)` job) | 162 | 0 | 0 |
| Vitest (`App tests (Vitest)` job) | 383 | 38 | 0 |

Vitest reports 39 test files (35 passed, 4 skipped) and 421 tests. It also
ran the production build and `npm run typecheck` in the same job; both
passed. pytest's 162 (4 warnings) includes `tests/test_curated_records.py`.

**The 12 pytest tests in `tests/test_curated_records.py`.** The earlier CI
run recorded here (42612670984, 2026-11-09) reported 150 because neither the
test file nor its fixture (`tests/fixtures/curated_records.json`) was
committed, so CI never found them and a local run reported 162. Both are
committed now (commit `8b9ead5`), so CI's 162 includes them and the local
and CI pytest counts agree. What the 12 tests check:

- `test_service_assigns_the_recorded_band` (10 of the 12: parametrized over
  5 curated activation records x 2 modes, `[activation_id-mode]`) -- the
  service still assigns the exact band recorded in the fixture for each of
  5 hand-picked real activations (a clean release, a caught fraud, a
  decision revised between submission and hold-close, a known miss, and a
  fairness-gap hold), at both T0 and T7.
- `test_fixture_labels_match_the_generated_dataset` -- the fixture's stored
  true labels (fraud status, typology, honesty type, agent id) still match
  what `data/internal_labels.parquet` actually holds for those activation
  ids, so a regenerated dataset with different activations under the same
  ids would fail here rather than silently changing what the bands above
  mean.
- `test_the_fixture_still_exercises_a_revised_decision` -- at least one of
  the 5 curated records still changes band between T0 and T7, so the
  fixture has not lost the one case it exists specifically to protect.

**The 38 Vitest tests skipped without a live server**, all behind a
`describe.runIf(up)` or `describe.runIf(live)` guard that checks for a
running app (`http://localhost:3000` by default), a running scoring service,
or a live chain:

- `tests/api-live.test.ts` (32 tests, one `describe.runIf(up)` block,
  `it.each` over 32 named cases) -- every API route rejects bad input
  cleanly (issue #18): anonymous admin route, agent on admin route, client
  on agent route, agent on client route, signup malformed JSON, signup
  invalid fields, signup as admin, queue with a bad tab, review detail for
  a missing activation, approve without a reason, refuse a missing
  activation, ask for evidence with malformed JSON, force T7 on a missing
  activation, assign without an agent, assign to a missing job, submit
  without multipart, submit with missing fields, accept a missing
  assignment, evidence reply without multipart, withdraw without a reason,
  contest a missing activation, post a job with no fields, fund with a
  negative amount, fund with shillings as text, fund with a fraction of a
  cent, close a missing job, report an empty week, report a day out of
  range, mark no notifications, evidence file that does not exist, cron
  without a secret, unknown API path.
- `tests/chain-live.test.ts` (2 tests, `describe.runIf(live)`, "the anchor
  contract and client on a live chain (B1, B4, C2)") -- records a root
  once, with its time, and refuses it a second time; anchors the audit
  chain through the real client, and verification reads it back from the
  chain.
- `tests/scoring-live.test.ts` (1 test, `describe.runIf(up)`, "live scoring
  service") -- accepts a T0 request built by the app and returns the T0
  model's thresholds.
- `tests/seed-live.test.ts` (3 tests, `describe.runIf(up)`, "seed data
  (issue #16)") -- seeds an empty database with every resting state, three
  roles, and payouts; can be rerun and produces the same data; refuses to
  clear a database holding accounts it did not create.

All 38 were run for real, against live services, at various points earlier
in this project's build sessions (see `app/BUILD_LOG.md` and this
document's own measurement sections above, several of which started the
same services these tests need); they are not untested code, only not
exercised inside CI's own environment.

## What this environment does and does not establish

- **NFR-01 and NFR-02's numbers are specific to this one mobile-class laptop,
  under no real network latency, with one scoring-service process.** They
  are real measurements, not invented, but they are not evidence about
  production hardware, because none exists for this project.
- **The embedded PostgreSQL and single-process uvicorn are not how a
  production deployment would be configured** (no connection pooling, no
  multiple scoring workers, no reverse proxy). A hosted deployment could
  measure differently in either direction.
