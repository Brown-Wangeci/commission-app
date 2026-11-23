# Scoring cron failure notice, 23 November 2026

cron-job.org emailed that the scoring job failed at about 13:40 to 13:45 EAT
(10:40 to 10:45 UTC), just after LF-000065 was submitted. This is what the
hosted database and the route code establish. All times are UTC with EAT
beside them; the database stores UTC (see `README.md`). Read only; nothing was
retried or changed.

## Finding

**Nothing failed in the app. The scoring service was slow to answer for about
100 seconds, and the scoring cron request that retried LF-000065 took about 45
seconds, which is probably longer than cron-job.org waits.** The retry
succeeded, nothing was lost and nothing was processed twice. Two latent
defects came out of it (17 and 18 in `../../../defects.md`), neither fixed.

| Link in the chain | Established? |
|---|---|
| The scoring service did not answer within 15 s on five consecutive calls, then answered in 13.5 s | Yes, `ScoringAttempt` rows |
| The cron request that made calls 4 to 6 ran for about 45 s | Yes, from the rows (below); the request log itself is not available |
| cron-job.org gave up on that request, so it reported a failure | **Not verified.** Its 30 s request limit is from its documentation as I recall it, and I could not read its execution history |
| The service was slow because it was waking from a spin-down | **Not established.** Consistent with the numbers; Render's own logs were not read |

## What happened

| Time (UTC, EAT beside) | Event | Source |
|---|---|---|
| 10:42:00.260 (13:42:00) | Agent's submission request starts; T0 scoring runs inside it | audit 965 |
| 10:42:02.022 (13:42:02) | `ScoringJob` for T0 created, trigger `submission` | ScoringJob.createdAt |
| 10:42:17.111 (13:42:17) | Call 1: timeout, 15005 ms | ScoringAttempt |
| 10:42:32.623 (13:42:32) | Call 2: timeout, 15002 ms | ScoringAttempt |
| 10:42:48.631 (13:42:48) | Call 3: timeout, 15001 ms. The inline run is over after about 46.5 s, the worst case in `docs/DEPLOY.md` | ScoringAttempt |
| about 10:42:49 (13:42:49) | The activation goes to `in_review` ("could not be scored, never auto-released"), a review item opens, the job is rescheduled with its `dueAt` set to 10:43:00.26 | audit 967, 968, ScoringJob |
| 10:43:00.630 (13:43:00) | The scoring cron request starts and takes the due job (this is the `at` of audit 969) | audit 969 |
| 10:43:15.688 (13:43:15) | Call 4: timeout | ScoringAttempt |
| 10:43:31.196 (13:43:31) | Call 5: timeout | ScoringAttempt |
| 10:43:45.734 (13:43:45) | Call 6: **succeeded** after 13530 ms. Decision recorded 10:43:45.742, job `succeeded` 10:43:45.778 | ScoringAttempt, ScoringDecision, ScoringJob |

The cron request therefore ran from 10:43:00.6 to at least 10:43:45.8, about
45 seconds, inside Vercel's limit (300 s) but long for a request that
usually has little to do. The other scoring cron
calls that day, including 10:42 and 10:44, had nothing due and are not in the
database.

For comparison, committed hosted evidence puts a warm Vercel to Render scoring
call at 0.29 to 0.35 s (`../performance/README.md`). The successful call took
13.5 s, about 40 times that, so the service was still not warm when it
finally answered.

## Retry, loss and duplicates

- **The retry succeeded.** One `ScoringDecision` for LF-000065: band
  `auto_release`, probability 0.117, recorded as advisory because the
  activation was already `in_review` (a reviewer owned it). It changed no state.
- **Nothing was lost.** The submission, its two photos, the job and the review
  item are all present, and the reviewer approved at 10:49:23 UTC (13:49 EAT)
  after the score had been recorded (whether they saw it is not in the data).
- **Nothing was double-processed.** For LF-000065: one `ScoringJob` (`attempts`
  2: the inline run and the cron run), one `ScoringDecision`, one review item,
  one `Disbursement`. The six `ScoringAttempt` rows are six HTTP calls, not six
  jobs.
- **Cost to the agent.** The submission request waited about 48 s for T0 to
  give up before answering, because T0 runs inside it by design.

## Why cron-job.org would report it

`/api/cron/scoring` runs each due job with up to `SCORING_IMMEDIATE_ATTEMPTS`
(3) calls of up to `SCORING_TIMEOUT_MS` (15 s), so one job can hold the
request for 46.5 s (`app/src/lib/time-budget.ts`, `scoringRunWorstCaseMs`).
The route stops starting new work at `CRON_TIME_BUDGET_SECONDS` (240 s), a
figure chosen for Vercel's limit, not for the scheduler's. If cron-job.org
waits only 30 s, any scoring cron run that meets a slow service is reported as
failed while the app finishes it. To confirm, open the job's history in
cron-job.org: the 10:43 UTC entry should show a timeout and a duration near
30 s.

## Defects recorded (not fixed)

- **17.** The scoring cron request can outlast the scheduler's request timeout,
  so a slow service produces failure notices for work that completes.
- **18.** Audit events and retry times in the scoring runner use the run's
  start time, not the moment of the event. Audit 968 reads 10:42:00.260 but
  happened at about 10:42:48.6, audit 969 reads 10:43:00.630 but the score
  finished at 10:43:45.71 (`ScoringDecision.scoredAt`), and the retry after the
  inline failure was due 12 s after it, not 60 s.

## What was not available

- The Vercel request log for the cron call: the Hobby plan does not retain
  runtime logs this long (the CLI answered "outside the available
  retention"). The request duration above comes from the database rows.
- cron-job.org's execution history and the Render service's logs.
