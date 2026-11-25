# Client review setting: hosted check, 25 November 2026

One run on the hosted app (`https://commission-app-ten-pied.vercel.app`)
against the hosted database. All times are UTC, with EAT (UTC+3) beside them;
the JSON files give UTC.

## Verdict

**Passed on the path it ran.** With the setting on for the seeded client
client2@ (Tujenge Pesa), activation LF-000067 scored `auto_release` at
hold-close and went to review with reason `client_requires_review`. Both scores
and their reasons were stored, and no payout was authorised.

## Deployment

| Time | Event |
|---|---|
| 08:00:58 UTC (11:00:58 EAT) | `prisma migrate status`: one migration pending, `20261125090000_client_review_setting` |
| 08:02:02 to 08:02:14 UTC (11:02:02 to 11:02:14 EAT) | `prisma migrate deploy` applied it ("All migrations have been successfully applied") |
| 08:02:23 UTC (11:02:23 EAT) | PR #94 squash-merged as `3a596ed` |
| 08:03:35 UTC (11:03:35 EAT) | Vercel production deployment `dpl_9FiX5WG6shLH4JszupNt4j2HvTRV` READY on `3a596eddb61bbb0d24ec8bdec0ed64d3878609f6` |

## The run

`review-on.json` (`hosted-verify.ts review-on`):

| Time | Event |
|---|---|
| 08:14:18 UTC (11:14:18 EAT) | Run started; the setting turned on through `POST /api/client/review-setting` (`changed: true`) |
| 08:14:23 UTC (11:14:23 EAT) | LF-000067 submitted on a new one-slot job that follows the account setting |
| 08:14:25 UTC (11:14:25 EAT) | T0 `t0_none-isotonic-v1`: probability 0.105, band `auto_release` (cut-offs 0.301, 0.729); state `held` |
| 08:14:27 UTC (11:14:27 EAT) | Engaged first week reported by the client |
| 08:19:23 UTC (11:19:23 EAT) | Hold window closed |
| 08:20:02 UTC (11:20:02 EAT) | State `in_review`; review item opened, `client_requires_review`. This time is the start of the scoring run, which is why it precedes the score |
| 08:20:03 UTC (11:20:03 EAT) | T7 `t7_none-isotonic-v1`, from the scoring cron job: probability 0.0015, band `auto_release` (cut-offs 0.267, 0.667) |

`review-off.json`: the setting turned off again at 08:22:26 UTC (11:22:26 EAT),
`changed: true`.

## What it does not show

- The setting off, or a per-job override, on the hosted app.
- A reviewer deciding LF-000067. It was left in review, with KSh 350.00 held on
  its job.
- The toggle or the post-a-job choice clicked on the hosted app: the check used
  the app's HTTP API.
- A direct database read. "No payout authorised" is what the app's review API
  returned (`payout.authorisation` null); no `payout_authorised` event is in the
  activation's audit trail in the same response.

The names in the files are seeded demo accounts. Checked before committing for
phone numbers, tokens and email addresses: none.
