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

## Issue #5: Escrow hold creation and derived state

- `assignJob` creates the assignment and its `EscrowHold` (amount = the job's
  payout per activation) in one transaction, after locking the job row with
  `SELECT ... FOR UPDATE`, so concurrent assignments cannot spend the same
  escrow twice. It refuses a closed job, a job with no free slots, and a job
  whose available escrow does not cover another payout.
- **Hold state is never stored.** The `EscrowHoldState` database view derives
  it from the activation state: no activation yet -> `reserved`; `approved`
  -> `released`; `refused` or `withdrawn` -> `returned`; anything else ->
  `held`. A test walks an activation through refusal, dispute and approval
  and checks the hold's state changes each time while the hold row itself is
  byte-for-byte unchanged.
- **Decision:** a refused activation's money counts as returned to the job's
  available balance. If that refusal is later contested, the hold reads
  `held` again. Because settlement is out of scope (#14), nothing is actually
  paid back, and a reassignment in the meantime could commit the same money
  twice. Recorded as a known gap for the settlement redesign.
- Job balance = deposits minus reserved, held and released holds.

## Issue #6: T0 scoring call at submission

- `POST /api/agent/activations` (multipart) validates the form, stores the
  evidence files, creates the activation and schedules its T0 score **in the
  same transaction**, then runs that score straight away. If the process dies
  after the commit, the scheduler (issue #7) finds the pending T0 job and
  scores it, so a submission can never be stranded unscored.
- The request carries T0 inputs only: `downstream_activity` is always empty
  in mode `t0` (and the payload builder only reads activity rows in mode
  `t7`). A test asserts this.
- History sent: every activation in the previous 90 days sharing the agent,
  device or customer number. Calendar sent: cycles from 30 days before to 60
  days after submission, created on demand.
- **Assumption: payout calendar.** 14-day cycles with an 18:00 Nairobi cutoff,
  mirroring `calendar.payout_cycle_length_days` and `payout_cutoff_hour` in
  `config/generator.yaml` (both marked "assumption" there). The first cycle
  starts Monday 5 January 2026, 00:00 Nairobi time; that anchor is an app-side
  assumption (`src/lib/payouts/calendar.ts`).
- **Assumption: network region.** The model compares the IP region with the
  region nearest the GPS fix. A browser cannot do geo-IP lookup, and no geo-IP
  database is bundled. The submission accepts an `ipRegion` from the device
  and, when none is sent, uses the region nearest the GPS fix. That means web
  submissions show no IP/GPS mismatch unless the region is set explicitly.
  The agent form exposes the field in a "simulated device" panel so a demo can
  set it. A real field app would fill it from the network.
- **Decision:** region display names (Nairobi, Kisumu, Mombasa, Eldoret) are
  the cities at the generator's coordinates; the codes sent are the model's
  (`region_a`..`region_d`).
- **Decision:** `job_id` sent to the model is the assignment id, because in
  the training data each job is one assignment yielding one activation.
  `job_id` is not a model feature.
- Customer numbers are stored only as a salted SHA-256 hash
  (`MSISDN_HASH_SALT`) plus a masked form for display (`07** *** 333`).
  `proof_of_activation_hash` is the SHA-256 of the proof file, if attached.
- Evidence files are stored on local disk under `EVIDENCE_STORAGE_DIR`, one
  folder per activation. Accepted types: JPEG, PNG, WebP, HEIC/HEIF, up to
  `EVIDENCE_MAX_BYTES` each, at most 12 photos.
- A live test (`tests/scoring-live.test.ts`) submits through the real scoring
  service when it is running and checks the stored thresholds and model
  version are the ones the service returned. It passed against
  `t0_none-isotonic-v1`.

## Issue #7: T7 scoring at hold-close

- **Window length:** `HOLD_WINDOW_SECONDS`, default 604800 (7 days). Seconds
  rather than days so tests and demos can use a window of a few seconds.
- **Scheduled path:** `npm run scheduler` polls every
  `SCHEDULER_INTERVAL_SECONDS` for due rows in `ScoringJob` and runs them. No
  timer is held in memory: the schedule is the table. Each job is claimed by
  a conditional update (`pending and due`, or `running` with an expired
  lease), so several workers and any number of restarts produce exactly one
  call. A test starts the scheduler as separate OS processes: once before the
  due time, then two at once after it, then again. The fake scoring service
  receives exactly one T7 request and the activation is decided once.
- **Manual triggers:**
  - `POST /api/admin/scoring/run-due` (admin) runs everything due now; the
    dashboard's "Run due scoring now" button calls it.
  - `POST /api/admin/activations/{id}/score-t7` (admin) forces T7 for one
    activation; the dashboard's hold-window panel has a "Force T7 now" button
    per held activation, and the review screen has one too (issue #12). On a
    held activation it closes the hold early and applies the band. On one a
    reviewer already owns (in review, awaiting evidence, disputed) the score
    is stored as advice and does not change the state.
  - `POST /api/cron/scoring` with `Authorization: Bearer $CRON_SECRET` for a
    hosted cron service; returns 404 when `CRON_SECRET` is unset.
- **T7 bands:** auto_release -> approved; review -> in_review; reject ->
  refused. This is the only automatic decision that moves money.
- **First-week activity:** the client reports it through
  `POST /api/client/activations/{id}/activity` (days 0 to 7; a report replaces
  earlier figures for the same days). **Demo concession:** the API does not
  stop a client reporting a day that has not happened yet, because a demo
  cannot wait a week. In production it should reject day d before
  submission + d days.

## Issue #8: Scoring service failure handling

- Failure kinds recorded per call in `ScoringAttempt`: `timeout` (slower than
  `SCORING_TIMEOUT_MS`), `unavailable` (connection refused or reset),
  `server_error` (5xx), `rejected_request` (4xx), `invalid_response` (a 200
  that fails schema validation or is for another activation or mode), and
  `missing_input` (the app could not build the request, for example no
  first-week activity at T7; no call is made).
- Each run makes up to `SCORING_IMMEDIATE_ATTEMPTS` calls with doubling
  backoff from `SCORING_IMMEDIATE_BACKOFF_MS`. A rejected request is not
  retried at once, since it would fail the same way.
- **A failed primary score never leaves the activation where it could be
  auto-released.** In the same transaction as the failure it moves to
  `in_review`, `unscoredStage` is set to `t0` or `t7` (the explicit
  could-not-be-scored marker), and a review item opens with reason
  `could_not_be_scored`. The job is rescheduled with doubling backoff from
  `SCORING_RETRY_BASE_SECONDS`, up to `SCORING_MAX_RUNS` runs, then marked
  `failed`.
- **A later successful retry is advice only:** the decision is stored and
  `unscoredStage` cleared, but the state stays with the reviewer. A test has
  the service down at hold-close, then back up and answering `auto_release`;
  the activation stays in review.
- `scoringHealth` gives the review queue the failure count, the last failure,
  the next retry time and whether retries have run out. The queue and review
  screen (issues #9 and #12) display it.
- One job's unexpected error no longer stops a batch run; it is logged and
  its lease lets the next poll retry it.

## Issue #9: Review queue backend

- **Queue:** `GET /api/admin/review?tab=waiting|evidence`. "waiting" is every
  activation a reviewer must decide (`in_review`, `disputed`); "evidence"
  holds items parked in `awaiting_evidence`. Oldest first, by when the item
  entered the queue. Each row carries the latest decision with both
  thresholds, the failure count, and the reasons **split into
  submission-level and agent-level lists**.
- **Detail:** `GET /api/admin/review/{id}` returns everything the review
  screen shows: queue position (N of M, previous and next ids), evidence with
  per-photo distance outside the job area, a summary (count, capture window,
  GPS accuracy range, photos without location, photos outside the area), the
  previous submission (time gap and distance), device, payout number and
  amount (from the escrow hold), the agent's statistics, every scoring
  decision with reasons by magnitude, the biggest risk-raising factor, the
  scoring health, the review history, evidence requests and the dispute.
- **Agent statistics are computed from that agent's activations only.**
  Approval rate = approved / (approved + rejected), where rejected counts
  refused and disputed. **Decision:** withdrawn activations are reported but
  excluded from the rate, since the agent withdrew them before any decision.
  With nothing decided the rate is `null` and the screen says "no decided
  submissions yet".
- **Actions** (admin only): approve, refuse, ask for evidence. A reason is
  required for every action (5 to 2000 characters). Each is a
  compare-and-swap transition with the reviewer as actor and the reason as
  note, and closes the review item with reviewer, time, reason and the id of
  the scoring decision in force.
- **Ask for evidence (correction 3):** `in_review -> awaiting_evidence`.
  Creates an `EvidenceRequest` (what was asked, by whom, when), notifies the
  agent, and moves the item to the evidence tab. The agent answers through
  `POST /api/agent/activations/{id}/evidence` with a note and/or photos. The
  request is marked answered, the new photos are linked to it, the activation
  returns to `in_review` with a new review item (`evidence_returned`), and
  the reviewer who asked is notified.
- **Decision: notifications are in-app only** (a `Notification` table shown
  on the agent's home screen and the admin's). No SMS or email is sent; the
  table is what a delivery channel would read from.
- **Decision:** an agent can withdraw an undecided activation (held, in
  review, awaiting evidence). Pending scoring jobs are cancelled and its
  escrow returns to the job.
- **Decision: clients cannot open evidence photos.** `GET /api/evidence/{id}`
  serves files to admins and the activation's own agent only; clients see
  outcomes, not customer photos.
- Migration note: `prisma migrate dev --create-only` also applies pending
  migrations, which produced one empty duplicate migration. It was removed
  before commit; the applied `20261028185524_notifications` only depends on
  the initial migration, so its sort position is harmless.

## Issue #10: Dispute record on refusal

- Every refusal creates a `Dispute` in the same transaction:
  - by a reviewer: carries the reviewer, their reason, the closed review item
    and the scoring decision in force;
  - automatically at T7: carries the T7 decision, no reviewer, and a reason
    built from that decision's own probability and reject cut-off.
- Approving creates no dispute (tested).
- **Decision: a refusal can be contested once.** The agent contests through
  `POST /api/agent/activations/{id}/contest` (refused -> disputed). The item
  returns to the waiting queue with a `dispute` review item, and the reviewer
  who refused is notified. A reviewer then upholds (refuse again, dispute
  `upheld`) or overturns (approve, dispute `overturned`). A second contest is
  refused with 409.

## Issue #12: Admin review screen and review queue

Built to the specified layout: top navigation with the "L Ledgerfield" mark,
Dashboard, Review queue (count badge), Agents, Clients, Payouts, Audit log,
and the signed-in reviewer's initials and name. The review screen
(`/admin/review/{id}`) has the breadcrumb with working Previous and Next,
the header, "What the agent submitted", "Check this first", "Submitted
details", the agent card, "Model assessment", the payout panel and the
closing line. Checked by screenshot at 1440 px and 390 px widths.

The four corrections:
1. **Thresholds.** No threshold exists anywhere in the UI code. The scale,
   the "why it is here" line and the queue all read `releaseThreshold` and
   `rejectThreshold` from the stored decision, which holds exactly what the
   scoring service returned for the model that produced the score. On seed
   data the screen shows 26.7% / 66.7% for T7 decisions and 30.1% / 72.9%
   for T0 decisions. A test checks the sentence changes when the decision's
   cut-offs change.
2. **No retraining claim.** Closing line: "The model advises; you decide.
   Your decision and your reason are recorded and shared with the agent and
   the client." A test fails if the framing or closing line mentions
   retraining, learning or feedback.
3. **Ask for evidence** opens a form for what the agent should send (see #9
   for the state and response flow); the item moves to the "Awaiting evidence"
   tab of the queue.
4. **Agent-level factors** carry an "About the agent" tag, a violet left rule
   and tint, and the list ends with a count ("1 of 3 factors describe the
   agent's past activity, not this submission"). When the biggest concern
   is itself about the agent, the "Check this first" callout says so in
   words ("This is about the agent, not this submission"). In the queue
   list, submission factors and agent factors are in separate columns, which
   is what issue #12 asks for ("kept apart").

Decisions made on the owner's behalf:
- **Decision: one ordering, marked, rather than two groups on the review
  screen.** The build instruction asks for factors "ordered by magnitude";
  issue #12 asks for agent reasons "kept apart". The review screen keeps one
  magnitude-ordered list with agent factors visibly marked; the queue list
  separates them into two columns.
- **Decision: "Check this first" explanations** come from a fixed mapping of
  each model feature to two or three plain sentences and inline actions
  (`src/lib/review/concern.ts`). The sentences explain what the factor means
  (from `docs/data_dictionary.md`) and quote only this submission's own
  records (for example "Photo 6 was taken 1.5 km outside the job area").
  They contain no statistics.
- **Decision: "captured <date> at <time>"** uses the earliest photo capture
  time; when no photo has a capture time it says "submitted" and uses the
  submission time.
- **Decision: "Sign-ups claimed" reads "1 (each activation is one
  customer)"**, following the one-activation-one-sign-up decision in #1.
- **Decision: the location map is an inline SVG drawn to scale** from the
  recorded coordinates (job area circle, submission fix, numbered photos,
  previous submission, agent's base), with an "Open in OpenStreetMap" link.
  No map tiles are loaded, so it works offline and sends no locations to a
  third party unless the reviewer clicks the link.
- **Decision: approving or rejecting from the queue still requires a
  reason**, typed inline.
- **Decision: the History section is read from the audit log** the database
  trigger writes, so it shows every transition with who acted and why,
  including the T0 and T7 scores and any failed scoring calls.
- The admin "View full history" link opens `/admin/agents/{id}`, every
  submission of that agent with its status, latest score and last human
  decision.
- An unscored submission shows "Fraud probability: Unavailable" and the
  recorded failures, never a number.

Bugs found by looking at the rendered pages and fixed: the "Submitted" audit
row carried the seed's run time rather than the submission time (the insert
trigger now receives the submission time and the agent as actor); a function
prop was passed from a server component to a client component on the
dashboard; stat tiles in grids were offset by a sibling-card margin.

## Issue #11: Agent view

- **My jobs** (`/agent`): unread notifications (evidence requests, decisions),
  jobs assigned and waiting to be accepted (Accept button), and accepted jobs
  ready for an activation.
- **Submit an activation** (`/agent/submit/{assignmentId}`): customer number,
  SIM registration date, scanned or typed, photos (up to 12), optional proof
  of activation, a note, and the GPS fix (from the browser, or entered by
  hand).
  - **Decision: photo time and place.** Each photo is stamped with the file's
    last-modified time and the device's current GPS fix when it is added.
    EXIF is not parsed, to avoid a new dependency; a field app would read
    the camera's own metadata.
  - **Decision: a "simulated device details (demonstration only)" panel**
    shows the browser-generated device id (kept in localStorage), the OS
    detected from the browser, app version `web-0.1.0`, network type, and
    the network-reported region (defaults to the GPS fix's region because
    there is no geo-IP lookup; see #6). It also has a "use the job area
    centre as my location (demo)" button, because desktop browsers often
    have no GPS. The panel is labelled as simulation, not hidden.
- **My activations** (`/agent/activations`): every activation with its status
  and the plain-language reason.
- **Activation detail**: status and reason; the reviewer's evidence request
  with a reply form (note and/or photos); contest a refusal (once);
  withdraw while undecided; the agent's own evidence.
- **Decision: what an agent is told.** A person's decision is quoted with
  the reviewer's reason. An automatic release or refusal is explained with
  that decision's own probability and cut-off, and an automatic refusal also
  lists the model's risk-raising reasons in plain words, so the agent can
  contest it meaningfully. Signed contributions and agent-level analysis
  stay on the reviewer's screen.
- Rehearsed in a real browser: Mercy answered an evidence request through the
  form and the activation moved from awaiting evidence to in review. This
  exposed a bug (the form was read after an `await`, when React had cleared
  it), which is fixed.

## Issue #13: Client view

- **Jobs** (`/client`): every job with funded and available escrow, slots
  used, and outcome counts.
- **Post a job** (`/client/jobs/new`): title, description, job area (place
  name, centre, radius 50 m to 50 km), payout per activation, commission rate
  (entered as a percentage, stored as a fraction), activations wanted, and an
  optional first deposit.
- **Job detail** (`/client/jobs/{id}`): escrow split into funded, locked,
  released and available (all derived from the holds, see #5), a "Fund
  escrow" form, and every activation with its outcome and reason.
- **First-week activity** (`/client/activations/{id}/activity`): a day 0 to 7
  table the client fills from its own records. The hold-close (T7) score
  reads it.
- **Decision: the client sees outcomes and reasons, not evidence or model
  internals.** The reason text is the same explanation the agent gets,
  worded for the client ("the agent withdrew it", no contest prompt). Customer
  photos stay with the reviewer and the agent.
- **Decision: the platform (an admin) assigns agents to jobs**, not the
  client. Issue #2 says a client must not reach agent data, and choosing an
  agent would need an agent directory. Admins assign from the Clients screen
  (built with the other admin screens).

## Stage 3, remaining navigation items (no issue of their own)

Built as thin but real screens on their own branch and pull request, since
no issue covers them:
- **Dashboard:** counts for every state, unread notifications, a warning
  when anything could not be scored, the last eight model scores and
  reviewer decisions, and the hold-window panel (force T7 / run due scoring).
- **Agents:** every agent with submissions, approved, rejected, withdrawn,
  pending and approval rate (or "Unavailable"), linking to the full history.
- **Clients:** every client business and its jobs with escrow position.
  Each job opens an admin job page with the **assign-an-agent control**
  (this is where assignments, and so escrow holds, are created in the demo)
  and the assignments with each hold's derived state.
- **Payouts:** authorised payouts with amount, payout number, who authorised
  it (a reviewer or automatic release) and the recorded status. It is empty
  until the payout boundary (#15) is wired in; it also warns if any approved
  activation lacks an authorisation.
- **Audit log:** every audit event newest first, 100 per page, with the
  activation, the actor and the recorded detail.

## Issue #15: Payout authorisation boundary

- `src/lib/payouts/boundary.ts` defines `PayoutAuthoriser` (a provider name
  and `authorise(tx, request)`) and the registry; `noop.ts` is the only
  implementation: it records a `PayoutAuthorisation` row (provider `noop`)
  and does nothing else.
- Upstream code calls only `authorisePayout`: a reviewer's approval (including
  overturning a contested refusal) and the automatic release at T7. The
  amount comes from the escrow hold; the number from the agent's profile.
- `PAYOUT_AUTHORISER` (default `noop`) selects the implementation. A test
  registers a different implementation and shows approvals go through it
  with no upstream change.
- **Decision:** the authoriser runs inside the approval's database
  transaction, so a failure rolls the approval back (tested). Whether a
  real settlement call belongs inside that transaction, or behind an
  outbox, is a settlement question and is left to #14.
- **Not built: #14 Settlement design**, as instructed. The issue stays open.
- The Payouts screen lists these authorisations; the review History shows
  "Payout authorised".

## Issue #16: Seed data

`npm run db:seed` (`prisma/seed.ts`). **It needs the scoring service
running**, because it never writes a score by hand. Every activation goes
through the real code: assignment and escrow, submission with placeholder
photos, T0 scoring by the real service, the durable T7 job run at the
hold-close time, and real reviewer and agent actions. Every probability,
band, cut-off and reason in the seeded data came from the scoring service.

What it creates (all fictional): two reviewers (Amina Otieno, David Mwangi),
two client businesses (Mwanga Mobile, Tujenge Pesa), six agents with
different histories (Grace Wanjiku 550 days and a clean record; Faith Chebet
820 days; Mercy Achieng 400 days with one refusal; Samuel Mutua with
refusals and a dispute; Kevin Omondi 60 days; Brian Kiprop 20 days), four
funded jobs with job areas in Nairobi and Kisumu, and 62 activations.
Accounts: `reviewer@`, `reviewer2@`, `client@`, `client2@`, `grace@`,
`faith@`, `mercy@`, `samuel@`, `kevin@`, `brian@` (all `@ledgerfield.test`),
password `ledgerfield-demo`.

Named cases, with the band the real model gave on the build run:

| Case | State | Scores |
|---|---|---|
| Grace, the mockup-like case | in review | T0 auto_release 0.105, T7 review 0.382 |
| Brian, escalated at submission | in review | T0 reject 0.747 |
| Kevin, evidence asked for and returned | in review | T0 reject 0.747 |
| Faith, could not be scored | in review, unscored (T0) | none |
| Samuel, contested refusal | disputed | T0 review 0.398, T7 reject 0.757 |
| Samuel, automatic refusal | refused (dispute open) | T0 review 0.398, T7 reject 0.757 |
| Mercy, band changes between T0 and T7 | approved | T0 review 0.494, T7 auto_release 0.001 |
| Mercy, awaiting evidence | awaiting evidence | T0 auto_release 0.271, T7 review 0.541 |
| four agents, one each | held | T0 auto_release |
| Grace | withdrawn | T0 auto_release |
| Brian, just submitted | submitted (T0 queued) | none yet |

- **The mockup-like case** (Grace, `LF-000050` on a fresh seed): she submits
  at Gikomba 22 minutes after a submission at Thika Road Mall 9.3 km away,
  photo 6 is 1.5 km outside the job area, the network reported Mombasa while
  the GPS fix is in Nairobi, no proof of activation, details typed in, a SIM
  registered the day before, and a customer inactive all week. The model's
  biggest concern is the missing proof (+1.04); her 531 days on the platform
  pull the other way (agent-level, -1.01). Her record shows 20 approved and
  none rejected.
- **How the cases were found:** the real model was probed with hand-built
  requests (scratch scripts, not committed). Long tenure dominates: an agent
  with about 3.6 years scores near 0.001 whatever the submission looks like.
  Distance from base *lowers* risk in this model.
- **Decision: risky cases are placed exactly two days before a payout
  cutoff**, so the model's days-to-cutoff input, and so the outcome, is the
  same whatever day the seed is run. The seed prints each named case's actual
  state and scores and says if any landed elsewhere.
- **Decision: two activations reuse a customer number** from an earlier
  activation, which is how Brian's and Kevin's escalations arise. Both are
  plausible re-registrations, and the reviewer sees "this phone number was
  activated before".
- **`scored_t0` and `scored_t7` are pass-through states.** The app moves an
  activation through them and on to its next state in one transaction, so
  no activation rests in them. Every seeded scored activation passed through
  them, which the audit log shows. Seeding one to rest there would mean
  creating a state the app itself never leaves an activation in.
- **The "could not be scored" case** is made by pointing that one submission
  at an unreachable address. Its background retry is due a minute later;
  once the scheduler runs with the service up, the retry's score is stored
  as advice and the flag clears. Show it before starting the scheduler.
- **Safe to rerun:** the seed refuses to touch a database containing any
  account outside `@ledgerfield.test`. Otherwise it truncates the app tables,
  restarts the reference counter, clears seeded evidence files and builds
  again. A live test runs it twice on an empty database (same counts both
  times) and checks the refusal.
- The seed pins a 7-day hold window for itself; a shorter
  `HOLD_WINDOW_SECONDS` in `.env` still applies to new submissions.
- Placeholder photos are flat PNG compositions generated in code
  (`prisma/seed-support/placeholder-png.ts`).

## Issue #17: End-to-end demonstration path

- `app/DEMO.md`: set-up, accounts, a tour of the review screen on the
  mockup-like case, a live path from job posting through funding,
  assignment, acceptance, submission, T0 scoring, first-week activity,
  forced T7, review and the final decision, an awaiting-evidence round trip,
  and optional extras (a scoring failure, the scheduled path, a contested
  refusal).
- **Decision: the live path branches on the T0 band it actually gets.**
  The model decides every band and the T0 score depends on the run date, so
  the demo cannot promise a fixed outcome. DEMO.md tells the presenter which
  first week to report: a dormant one if T0 was auto-release, an active one
  if T0 was review or reject. Either way the band changes between T0 and T7.
- **Rehearsed twice with no manual database edits** (28 October 2026, on a
  fresh seed, against `next start`):
  - `npm run demo:rehearse` (committed, `scripts/rehearse-demo.ts`): signs in
    as each role and walks the path through the app's HTTP API. Result: T0
    auto_release 24.1% -> dormant week -> T7 review 54.1% -> approved by the
    reviewer -> payout authorised; then evidence requested on LF-000050 ->
    Grace replied -> back in review -> approved.
  - A headless browser clicked through the real forms (client posts and
    funds, admin assigns, agent accepts and submits with uploaded photos,
    client reports the week, admin forces T7 and approves). Result: held ->
    T7 review 50.9% -> approved; the Payouts page lists the authorisation.
    The browser script lives in the scratchpad, not the repository, because
    it needs a local Chrome.
- Added `GET /api/admin/agents` for the rehearsal script, and made the
  hold-window panel's references link to the review screen.

## Issue #18: Error handling and input validation

- **One error shape** for every API route:
  `{ "error": { "code", "message", "details"? } }`. Every route handler is
  wrapped in `withErrors`, which converts anything thrown:
  - zod validation errors -> 422 `validation_failed` with per-field details;
  - malformed JSON or a non-multipart upload -> 400 `bad_request`;
  - `ApiError`s -> their own 4xx (401, 403, 404, 409, 413, 415);
  - **new:** a transition the database trigger rejects -> 409
    `illegal_transition`; Prisma "not found" (P2025) -> 404; unique and
    foreign-key violations (P2002, P2003) -> 409;
  - anything else -> logged with the route name, returned as a generic 500
    `internal_error` with no internal message or stack.
- **New:** an evidence record whose file is missing on disk -> 404 (was 500).
- **New:** any `/api` path with no route answers 404 in the same JSON shape
  (`src/app/api/[...unknown]/route.ts`) instead of an HTML page.
- Middleware already answers 401/403 in the same shape for protected API
  paths.
- **New:** page error, not-found and global-error pages in the app's style,
  showing a reference digest but no internal detail.
- **Exception, recorded:** NextAuth's own `/api/auth/*` endpoints keep
  NextAuth's responses; they are library routes, not ours.
- **Exception, recorded:** an HTTP method a route does not define gets Next's
  built-in 405 with an empty body.
- Tests: unit tests for the mapping and the wrapper (including that a 500
  leaks nothing and is logged), and a live matrix (`tests/api-live.test.ts`)
  of 30 bad requests across every route and role, run against `next start`
  with seed data: all 30 returned the expected 4xx in the standard shape with
  no stack trace. It is skipped when no app is running.

## Issue #19: Deployment and environment configuration (left open)

Done:
- `.env.example` lists every variable the app, scripts and tests read, with
  defaults and no secrets. A scan of `app/` found no committed secret; `.env`,
  the local database directory and evidence storage are git-ignored.
- `app/README.md`: requirements, first-time setup, running the app and the
  scoring service together, the scheduler, every configuration variable,
  tests, deployment steps, layout and known limitations.
- `npm run dev:all` (`scripts/run-all.ts`) starts the local database, the
  scoring service (with the repository's `.venv`), the app and, with
  `--scheduler`, the scheduler, with labelled output. Tested: `/api/health`
  reported database and scoring service OK.
  - **Found and fixed while testing:** a scheduler that polls before the
    scoring service has loaded finds it "down" and, correctly but needlessly,
    sends due activations to review as unscored. `dev:all` now starts the
    scheduler only on request and only after the scoring service reports its
    models loaded.
- `npm run start:deploy` runs `prisma migrate deploy` and then `next start`,
  so migrations run as part of every deploy. `next start` honours `PORT`.
- `GET /api/health` for hosting health checks.

**Not done, and why #19 stays open:** the issue asks for the app to deploy
to a hosted environment and pass the demonstration path there. That needs
your hosting account, a hosted PostgreSQL, a place to run the Python scoring
service with its model artifacts (which are not committed), persistent
storage for evidence files, and secrets. None of that can be created from
here without your accounts. The README's "Deploying" section lists the
steps. No Dockerfile was written: Docker is installed but its daemon was not
running, so a container build could not be tested, and an untested
deployment file would be a guess.

## End of build: status

- **Closed (17):** #1 to #13, #15 to #18, each merged through its own pull
  request (#20 to #37). The remaining admin screens went in through PR #33,
  and #19's configuration work through PR #38.
- **Open (2):** #14 Settlement design, not built as instructed; #19, the
  configuration is merged, but the hosted deployment needs the owner's
  accounts (see the #19 entry).
- **Final check on `main`** (commit `c43ad16`, 28 October 2026): production
  build passes; 137 of 137 tests pass, including the live scoring-service,
  seed and 30-case API suites with the scoring service and `next start`
  running; the seed reports every named case where intended.
- **Rehearsed end to end** through the API and through a real browser (see
  #17); no manual database edits.
- **GitHub API:** no gh command failed during the build.
- **Owner's uncommitted ML work** at the repository root was never staged or
  changed.

## Build 1: money model and commission (issues #40 to #43)

Scope as instructed: the money model, commission calculation, escrow locking
and the feature vector. Evidence configuration, M-Pesa and blockchain were
not touched.

### Issue #40: money in integer cents (NFR-07, DR-08)
- Every money column is an `Int` of Kenyan Shilling cents named `...Cents`:
  `EscrowDeposit.amountCents`, `EscrowHold.amountCents`,
  `PayoutAuthorisation.amountCents`, `Job.submissionValueCents`,
  `Job.flatCommissionCents`, `Job.escrowLockedCents`, the `Commission`
  amounts, and the view's `amountCents`. Rates are `Int` basis points
  (`commissionRateBps`). No money column is Float or Decimal.
- **Decision (A2): the customer top-up became integer cents (`topupCents`),
  not a renamed Float.** It is money (a KSh amount the customer paid), so
  calling it "not monetary" would be a relabelling rather than a fact, and
  NFR-07 says all monetary values. Cents lose nothing: the amounts have at
  most two decimals. The model was trained on shillings, so the scoring
  payload converts cents to shillings at the boundary, in one place
  (`shillingsForModel` in `src/lib/scoring/payload.ts`), from the decimal
  text of the cents, and the rate to a fraction (`rateForModel`). Those two
  are model inputs, not money the platform computes with.
- `src/lib/money/cents.ts` parses shillings text to cents and formats cents
  as `KSh 4,750.00` (design-system rule: full amount, two decimals, true
  minus sign) with string and integer operations only. Sums and products use
  BigInt and refuse anything that is not a safe integer.
- **Build check (A3):** `scripts/check-money-columns.ts`, run first by
  `npm run build`. A Float or Decimal column fails unless it is in an
  allow-list of non-money columns with a reason (coordinates, scores,
  minutes); a numeric column whose name looks like money must be an `Int`
  named `...Cents` or `...Bps`. The same allow-list is checked against the
  migrated database's `information_schema` in `tests/money-columns.test.ts`.
  Shown failing: with `EscrowHold.amountCents` as Float and `topupCents` as
  Decimal it lists both and exits 1.
- **Migration (A4):** `20261029100000_money_in_cents`, written by hand
  because Prisma's generated SQL would drop the old columns before copying
  them. It multiplies every amount by 100 and checks each conversion,
  stopping with an error rather than storing a wrong or oversized value.
  Each old flat payout becomes a structure that reproduces it to the cent:
  the old rate as basis points, a submission value of
  `ceil(payout cents x 10000 / bps)`, no flat amount. Verified on a copy of
  the seeded development database (the original was not touched): 4 jobs
  reproduce their payouts exactly; 48 approved activations got 48 commission
  records, each equal to its hold and its payout; deposit, hold, payout and
  top-up totals are exactly x100; no balance is negative.
  `tests/migration-money.test.ts` repeats this on its own legacy fixture,
  including an underfunded job, an overfunded job and a rate that does not
  convert to whole basis points (0.12345 becomes 1235).
- **Ceiling, recorded:** one row holds at most KSh 21,474,836.47 (a
  PostgreSQL INTEGER). BigInt columns would lift it but make every amount a
  JavaScript bigint, which JSON cannot carry; not worth it at this scale.
  Publication above the ceiling is refused with a clear message.

### Issue #41: commission structure and calculation (FR-18, FR-04 in part)
- **Decision: "job value" is the value of one approved submission**
  (`submissionValueCents`), the base the rate applies to. The commission is
  computed per approved submission (B3), and applying the rate to a job's
  total value on every submission would pay the whole job's commission each
  time. If "job value" was meant as the total, only this field's meaning and
  the form label change.
- `commission = floor(value x bps / 10000) + flat`, BigInt multiplication and
  integer division, in `src/lib/money/commission.ts`. The rate must be 1 to
  10000 bps, because the scoring service requires a rate above zero; a
  structure that pays nothing per submission is refused.
- On every path to approval (reviewer approval, automatic release at
  hold-close, an overturned dispute) `authorisePayout` writes one
  `Commission` record in the approving transaction, copying the structure,
  rate component and amount. The payout authorisation pays that amount and
  is linked to it. The database enforces the rest: one per activation, only
  for an approved activation and its own job's structure, amount equal to
  floor plus flat (CHECK), append-only (trigger), and an authorisation must
  pay exactly its commission (trigger).
- **Decision: a published job's structure, slots and lock are fixed** (a
  trigger rejects changes), so the hold reserved at assignment always equals
  the commission computed at approval; `authorisePayout` still checks and
  refuses a mismatch rather than paying it.
- **Derivation lines (B5):** every computed amount on screen has one, e.g.
  "KSh 1,234.56 × 8.25% = KSh 101.85 (rounded down to the cent) + KSh 20.00
  flat". The APIs return them: `GET /api/admin/review/{id}` (`payout.amount`)
  and the new `GET /api/client/escrow`. Checked on the running build: every
  money page renders them, and none shows a whole-shilling amount.
- FR-04's deadline is not part of this build.

### Issue #42: escrow locked at publication, released at close (FR-07, FR-20)
- **Decision: escrow belongs to the client, not the job**, as FR-07 and
  FR-20 describe ("the client's available balance"). Deposits move to the
  client (`POST /api/client/escrow/fund`; the per-job fund route is gone).
- Publishing locks `slots x commission` with the client row locked
  (`SELECT ... FOR UPDATE`), so two publications cannot spend the same money;
  it is refused with a 409 naming the shortfall, and a deposit sent with a
  refused job is rolled back too.
- Closing (`POST /api/client/jobs/{id}/close`) returns the lock less
  everything reserved, held or released. Money still reserved or held stays
  committed until decided: released on approval, returned on refusal or
  withdrawal. A closed job cannot reopen (trigger) or take assignments.
- Escrow stays derived (C3): the hold view is unchanged except for cents, and
  balances are computed from deposits, locks and hold states.
- **Converted jobs** lock the smaller of their maximum liability and what was
  deposited for them, so no client starts negative and no job can commit
  more than it was funded for. The UI says when a lock is below the full
  liability.
- **Found, not fixed:** closing a job does not cancel its unsubmitted
  assignments, so their reservations stay committed until submitted and
  decided.

### Issue #43: full feature vector on each decision (DR-10 groundwork)
- The scoring service already computed the vector and kept it for
  `/explain`; `/score` now returns it (`feature_vector`, two lines in
  `src/serve/schemas.py` and `src/serve/app.py`, with a test that it matches
  the training pipeline's values for T0 and T7). The app requires it in the
  contract and stores it in `ScoringDecision.featureVector` (JSONB,
  append-only with the decision; null on decisions recorded earlier).
- No retraining loop was built. DR-10 remains a documented deviation.
- **The running scoring service must be restarted** to return the vector;
  an old process's responses are now treated as scoring failures.

### Found during this build
- **The local PostgreSQL cluster is WIN1252, not UTF8.** It rejected the
  true minus sign (U+2212) in an audit entry. Stored audit text now avoids
  it (display strings keep it). Not changed: re-initialising the cluster
  would discard the development data. A hosted database should be UTF8.

### Verification
- App: 185 of 185 tests pass with the scoring service and `next start`
  running (no live test skipped). Python: `tests/test_serve.py` 44 of 44.
- `npm run build` passes, the money check included; `prisma migrate diff`
  between the migrations and the schema reports no difference.
- `npm run demo:rehearse` passed against a migrated copy of the seeded
  development database, including approving a migrated activation.
- The development database itself was not migrated. Run `npm run db:migrate`
  (and restart the scoring service) before using it with this build.

## Build 2: configurable evidence submission (issues #45 to #52)

Scope as instructed: the evidence framework, the job deadline and CI.
M-Pesa and blockchain were not touched.

### Issue #45: the database must be UTF8 (pre-step)
- `src/lib/db-encoding.ts` reads the connected database's encoding.
  `src/instrumentation.ts` runs it when the Next.js server starts and, on a
  database that is not UTF8, prints the reason and the instruction and exits
  with code 1. The scheduler and the seed check too; `/api/health` reports
  `not_utf8` with a 503. A database that cannot be reached at start is not
  called wrongly encoded; health reports it as before.
- Shown working against the owner's real development database (WIN1252),
  which was only read: `next start` printed "The database "ledgerfield" is
  encoded WIN1252, not UTF8 ..." and exited 1. The cluster was not altered.
- **Decision: the README gives `createdb -E UTF8 --template=template0` and
  adds `--locale=C`**, because on a cluster with a Windows `..1252` locale
  PostgreSQL refuses a UTF8 database without a compatible locale.
- **Decision: `npm run db:create -- <name>`.** The embedded PostgreSQL ships
  no `createdb`, so this script runs the equivalent `CREATE DATABASE` against
  the server in `DATABASE_URL`; it only creates, and refuses an existing name.
- `npm run db:start` now creates missing databases as UTF8 and initialises a
  new cluster as UTF8; it never changes an existing database. The test suite
  creates every throwaway database as UTF8 with the C locale, which works on
  any cluster; tests/db-encoding.test.ts creates a WIN1252 database and
  checks the refusal.

### Issue #46: per-job evidence configuration (FR-05, DR-06, DR-07)
- **Decision: two kinds of field, one definition format.** The platform's
  own fields (customer number, SIM date, capture method, proof, note;
  `src/lib/evidence/platform.ts`) are the observable inputs the fraud model
  reads, stored in the activation's fixed columns. A client's fields are
  stored as JSON. Both are written as the same field definitions, rendered
  by the same component and validated in the same pass, so the form
  hardcodes no field while the model's inputs stay fixed.
- Types: text, number, date, choice from the client's list, Kenyan mobile
  number, photo. Each has its own expected format (text: allowed characters
  and length; number: decimal places and bounds; date: future allowed or
  not; choice: the options; photo: fewest and most).
- **Decision: text formats are presets, not client-written regular
  expressions.** A client's regex runs on the server for every submission,
  and a badly written one can hang it.
- **Decision: no currency type.** An evidence field is information about the
  work, never money the platform holds, so it cannot bypass the cents rules.
- **Representation (DR-06):** `EvidenceConfig.fields` (JSONB, an ordered
  array of definitions) and `Activation.evidencePayload` (JSONB, values by
  field key; a photo field holds its photos' evidence numbers). Files stay in
  `EvidenceItem`, which gains `fieldKey`, so each photo keeps its own
  capture time and location (B2).
- **Versions (A3):** each edit adds the next version; a trigger makes
  versions append-only. A submission is validated against the version in
  force and records it in `Activation.evidenceConfigId` (a foreign key that
  must name a version of the activation's own job); a trigger makes that and
  the payload unchangeable. Field keys (`field_N`) survive edits, and a new
  field never reuses a removed field's key.
- **Decision: a form opened before an edit is refused with a 409** ("reload
  the form"), so a submission is always judged by the version in force when
  it arrives. The offline build (WP5) will need to decide whether a
  submission captured offline under an earlier version is honoured.
- **Privacy, recorded:** a client's phone field stores the number as typed
  (normalised) in the payload, unlike the customer number, which is hashed.
  It is personal data a client chose to collect; it falls under NFR-13 and
  the DR-11 retention work.
- **Migration:** every existing job gets version 1 holding the evidence all
  jobs asked for before (one to twelve photos); every activation is linked
  to it with its photos listed. Verified on a copy of the seeded development
  database: 4 jobs, 62 activations, 341 evidence files, each linked and filed
  correctly (the one reply to an evidence request under no field);
  tests/migration-evidence.test.ts repeats it on its own fixture.

### Issues #47 and #48: the capture form and validation (FR-09, FR-12)
- The form renders the platform's fields, then the job's, from their
  definitions (`EvidenceFieldInputs`), and sends `evidenceConfigId`.
  `GET /api/agent/assignments/{id}/evidence-form` returns the same
  definition for a future offline client.
- The server validates everything in one pass. A missing mandatory field is
  named ("Missing mandatory fields: SIM serial number, Customer type, ...");
  every failure is reported against its field as `fields.<key>`. Values under
  keys the configuration does not have are ignored and never stored. The
  form runs the same rules in the browser first; the server never relies on
  it.
- **Interpretation recorded:** the device's own context (GPS fix, device,
  network) is captured by the device, not typed as evidence, so it stays out
  of the configurable fields.

### Issue #49: the layer boundary
- The scoring payload never reads the evidence payload, and
  `assertFixedShape` refuses to send a request with any key outside the data
  dictionary. tests/layer-boundary.test.ts fills every client field type with
  sentinels and checks none reaches the T0 request, the T7 request, or a
  later activation's history, and that rewriting the stored payload leaves
  the request identical. On the service side, `tests/test_serve.py` checks
  a request carrying client evidence is rejected and the model scores
  exactly the 27 fixed features.

### Issue #50: the review surface
- Submitted fields are listed with the labels of the submission's own
  version, which the screen names ("the job has since moved to version 2"
  when it has). Photos are grouped per photo field in the design system's
  grid: square tiles, a mono index badge, capture time and GPS accuracy
  under each tile, flagged tiles outlined and tinted amber with the reason
  written inline.
- **Found and fixed while checking the rendered pages:** with more photos
  than fit, a flagged photo could sit behind "View all" with its reason
  unseen. Flagged photos now take the visible places first.

### Issue #51: job deadline (FR-04)
- Set when posting, stored as the end of that day in Kenya, fixed after
  publication (trigger). After it, no assignment, acceptance or submission.
  Jobs published before deadlines existed keep none.

### Issue #52: CI (NFR-14)
- `.github/workflows/ci.yml`: the app suite against a PostgreSQL container,
  the build and typecheck; the Python suite after regenerating the dataset
  and the artifacts, which are not committed. **Not done:** requiring the
  check before merge is a branch-protection setting on the repository, which
  this build did not change.

### What every submission retains (DR-07, E)
Checked rather than assumed. Retained on the record itself, all NOT NULL:
the submission timestamp, the device location (latitude, longitude, with
accuracy when known) and the configuration version. Missing or weaker than
the requirement's words:
- **The submission's capture time is when the server received it.** There is
  no device-reported capture time for the submission; an offline capture
  would be stamped when it syncs.
- **A photo's capture time is the file's last-modified time**, not EXIF, and
  can be absent; its location is the device's fix when the photo was added.
- **Where the location came from is not recorded.** The agent can type it,
  or use the demo button, and the record cannot tell those from a GPS fix.

### Found during this build
- The scheduler test used a 4-second hold window; a scheduler process now
  starts slowly enough that the window closed before its first run. It uses
  12 seconds.
- The seed's Mercy "awaiting evidence" case moved from review to reject: the
  agent now enters the SIM date as a calendar date, which made that SIM
  about 41 hours old at submission instead of 32, and a probe against the
  real model showed the case turns at about 36 hours. That case now uses a
  same-day SIM; every named case lands where intended.

### Verification
- App: 235 of 235 tests passed with the scoring service and `next start`
  running (no live test skipped), on a UTF8 database. After the last two
  changes (the flagged-tiles rule and its test), the suite was rerun without
  the live services: 202 passed, the 36 live tests skipped, none failed.
  Python: the serving tests pass, including the new boundary test.
- `npm run demo:rehearse` passed: a client-defined job, a form built from
  version 1, approval with the commission recorded.
- 22 checks on the rendered pages passed: review grid and labels by version,
  two different capture forms, the client's editor and version history.
