# Ledgerfield build log

A running record of every decision made on the project owner's behalf while
building the application layer, every assumption, and everything left
incomplete and why. Entries are appended in the order the work was done.

## 0. Before any code

### Environment found
- Node 24.14.0, npm 11.11.1, gh 2.102.0 (authenticated with `repo` and
  `project` scopes), Python 3.14.3 with the ML service's `.venv`.
- No system PostgreSQL. Docker is installed but its daemon was not running.
- **Decision:** use real PostgreSQL through the `embedded-postgres` npm package
  (PostgreSQL 17.6 binaries shipped as an npm dependency). `npm run db:start`
  starts a local cluster in `app/.pgdata` on port 5433. SQLite was not needed.
  Any other PostgreSQL (Docker, hosted, system install) works by changing
  `DATABASE_URL`.
- The scoring service starts with
  `.venv/Scripts/python.exe -m uvicorn src.serve.app:app --port 8000` and
  `/health` reports both models loaded (`t7_none-isotonic-v1`,
  `t0_none-isotonic-v1`).

### Working rules
- The repository `CLAUDE.md` says to stop at the end of each phase for review.
  Its heading scopes it to the ML component, and the build instruction says to
  work autonomously without stopping. **Decision:** the build runs through
  without pausing. Nothing at the repository root is modified.
- The owner's uncommitted ML work at the root (`README.md`,
  `scripts/reproduce_all.py`, `scripts/score_example.py`, `tests/fixtures/`,
  `tests/test_curated_records.py`) is left untouched and is never staged. Only
  `app/` is ever added to a commit.

### Pinned stack
Next.js 15.5.28 (App Router), React 19.1.10, TypeScript 5.9.3, Prisma 6.19.3,
NextAuth.js 4.24.15, zod 3.25.76, Vitest 3.2.4. Versions are pinned exactly.
Next 16 and Prisma 7 exist but change routing middleware and client generation
respectively; the 15.x / 6.x lines were chosen as the stable, well-understood
combination for a demonstration build.

### Facts taken from the scoring service (not invented)
- `POST /score` takes `mode` ("t0" or "t7"), the activation event, the agent
  register rows, recent activations, a payout calendar, and (T7 only) the
  downstream activity log. It returns the calibrated probability, band,
  `release_threshold`, `reject_threshold`, model version and the top reasons,
  each with `is_agent_level`, `direction`, `shap_value` and a plain-language
  `description`.
- The service rejects T0 requests that carry downstream activity and T7
  requests that lack it.
- Training timestamps are naive local times. **Decision:** the app sends every
  timestamp as naive Africa/Nairobi wall-clock time (UTC+3, no daylight
  saving), so `submission_hour_of_day` means the same thing it meant in
  training.
- `ip_location_mismatch_flag` compares the IP region against the region
  nearest the GPS fix, using the four region codes `region_a` to `region_d`
  in `config/generator.yaml`. The app uses the same codes and coordinates.
- Trailing-window features need history: the app sends every activation in
  the previous 90 days (`features.msisdn_history_days`) that shares the
  agent, the device or the customer number with the scored one.

## Issue #1: Prisma schema and migrations

- **Decision: one activation is one customer sign-up.** The scoring model
  scores one customer per request (one phone-number hash, one SIM
  registration date), and `README.md` at the root describes the system as
  deciding "twice for every sign-up". An activation in this app is therefore
  exactly one sign-up. The design's "claims N sign-ups" line is rendered from
  the data and reads "1 sign-up". Supporting multi-customer submissions would
  need a change to the scoring contract, which is outside this build.
- **Decision: job, assignment, hold.** A client posts a *job* (a campaign with
  a circular job area, a payout per activation, a commission rate and a number
  of slots). Assigning the job to an agent creates an *assignment* (one slot,
  one future activation) and its *escrow hold* in the same transaction. This
  matches the scoring model's per-activation `job_assigned_timestamp` and
  `job_accepted_timestamp`, and satisfies both the build instruction ("hold
  created when a job is assigned") and issue #5 ("a hold is created when an
  activation is submitted"): the hold exists from assignment and is bound to
  the activation by the assignment's unique key.
- **Decision: `agentId` and `jobId` are stored on the activation** for
  querying, and a composite foreign key to `(assignment.id, agentId, jobId)`
  makes it impossible for them to disagree with the assignment.
- **Decision: a `withdrawn` state was added** beyond the nine listed states.
  The agent card in the design shows approved, rejected and *withdrawn*
  counts; without a withdrawn state that number could only be invented.
- **Decision: the client reports first-week customer activity**
  (`CustomerActivityDay`, days 0 to 7). T7 scoring needs it and a client
  business (the operator whose service the customer signed up for) is the
  party that observes it.
- Field rules Prisma cannot express (positive amounts, coordinate ranges, a
  SIM registered before submission, day 0 to 7, ordered thresholds) are CHECK
  constraints added to the initial migration.
- **Testing constraint found:** Prisma 6.19 refuses `prisma migrate reset`
  when it detects an AI agent, and asks for the user's explicit consent. I did
  not bypass that. Instead each test run creates its own uniquely named
  database, applies the migrations with `prisma migrate deploy`, and drops
  that database at the end. This also proves the migrations apply to an empty
  database from scratch on every run. You can still use `npm run db:reset`
  yourself on a development database.
- `package.json#prisma` (seed command) triggers a Prisma deprecation warning.
  Moving to `prisma.config.ts` stops Prisma loading `.env` automatically, so
  the warning was left in place.

## Issue #4: Scoring decision storage

- `ScoringDecision` is a one-to-many child of `Activation`. Each row stores the
  model (`t0`/`t7`), model version, feature set, raw score, calibrated
  probability, band, both thresholds in force, when the service scored it and
  why the call was made (`submission`, `hold_close`, `admin_forced`,
  `retry`). Its reasons are child rows with rank, feature, plain-language
  description, signed contribution, direction and the agent-level flag.
- Append-only is enforced by the database: a trigger rejects every UPDATE and
  DELETE on `ScoringDecision`, `ScoringReason` and `ScoringAttempt`.
- Service responses are validated with zod before storage. A response whose
  thresholds are out of order, whose probability is outside 0 to 1, or which
  is missing a field is treated as a scoring failure, not a score.

## Issue #2: Authentication and role separation

- NextAuth.js 4 with an email and password credentials provider and JWT
  sessions (8 hours). The role is copied into the token at sign-in so
  middleware can check it without a database call.
- **Decision: route policy lives in one table** (`src/lib/auth/policy.ts`):
  `/admin` and `/api/admin` need admin, `/agent` and `/api/agent` need agent,
  `/client` and `/api/client` need client. `src/middleware.ts` applies it to
  every request (pages redirect, APIs return 401/403 JSON), and every route
  handler checks the role again with `requireApiRole`, so a missed matcher
  cannot expose a route.
- **Decision: public sign-up creates agent and client accounts only.** Admin
  accounts come from the seed script. A public form that could create a
  reviewer would let anyone approve payouts.
- Agents give an M-Pesa payout number and a base location at sign-up (the
  scoring model needs `agent_home_lat/lon` and `agent_registration_date`).
  Kenyan numbers are accepted as 07.., 01.., 254.. or +254.. and stored as
  0XXXXXXXXX.
- The standard error body `{ "error": { "code", "message", "details" } }` was
  introduced here because sign-up needed it; issue #18 extends it everywhere.
- Visual language set up in `src/app/globals.css`: paper background, white
  cards, one green accent for money and primary actions, rust for "raises
  risk", slate blue for "lowers risk" (chosen over red and green so the pair
  stays distinguishable for colour-blind reviewers), violet for agent-history
  factors.

## Issue #3: Activation state machine with data-layer enforcement

- **The lifecycle** (defined once in `src/lib/activations/states.ts`):

  | From | To |
  |---|---|
  | submitted | scored_t0 (T0 scored), in_review (T0 could not be scored) |
  | scored_t0 | held (T0 band auto_release or review), in_review (T0 band reject) |
  | held | scored_t7 (T7 scored), in_review (T7 could not be scored), withdrawn |
  | scored_t7 | approved (auto_release), in_review (review), refused (reject) |
  | in_review | approved, refused, awaiting_evidence, withdrawn |
  | awaiting_evidence | in_review (agent responded), withdrawn |
  | refused | disputed (agent contests) |
  | disputed | approved (overturned), refused (upheld) |
  | approved, withdrawn | final |

- **Decision: T0 never moves money.** At submission an `auto_release` or
  `review` band puts the activation on hold until T7; a `reject` band sends it
  straight to a reviewer instead of refusing it automatically. Reasons: the
  research README shows a submission-time release is money already paid
  before the stronger seven-day model sees the case, and the cost matrix
  prices refusing an honest agent above paying one fraud, so an automatic
  refusal on the weaker model's word is the costliest kind of error. Only the
  T7 band acts automatically (release, review or refuse).
- **Decision: a refused activation can be contested once.** refused ->
  disputed -> approved/refused. The table allows the loop; the application
  blocks a second contest because the dispute record is already resolved.
- **Enforcement in the database:** the pairs are loaded into
  `ActivationTransitionRule` by migration (SQL generated from the TypeScript
  table by `scripts/transition-sql.ts`). A trigger on `Activation` rejects an
  insert in any state but `submitted` and any state change not in the table,
  for every client, including raw SQL. The rule table is read-only to every
  client. A test checks the database table equals the TypeScript table, and
  another writes every illegal pair (over 60) directly with SQL and expects
  each to fail.
- The same trigger writes every accepted change to `AuditEvent`, with the
  actor, note and time passed through `set_config`, so the audit log cannot
  miss a transition, even one made outside the app.
- `transitionActivation` is a compare-and-swap (`WHERE state = from`), so two
  reviewers acting at once cannot both succeed; the loser gets a 409.
- **Found and fixed:** the local PostgreSQL ran in Africa/Nairobi time while
  Prisma stores UTC, which would have put trigger-written timestamps three
  hours off. The migration pins the database timezone to UTC and the trigger
  computes UTC explicitly.

