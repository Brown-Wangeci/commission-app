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

