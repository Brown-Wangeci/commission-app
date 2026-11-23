# Step 18: hosted M-Pesa test, 23 November 2026

One STK Push (funding) and one B2C payout (disbursement) run on the hosted
deployment against the Safaricom Daraja sandbox, and what the hosted Neon
database recorded for them. All times are UTC, with EAT (UTC+3) beside them;
the JSON files give both for every timestamp. The database stores timestamps
as `timestamp without time zone` holding UTC (the server's `TimeZone` is UTC),
so `10:15:39.877` in the raw row is 13:15:39 EAT. The first version of this
folder labelled those UTC values as EAT because the reading client's zone was
EAT; the tester's own account of funding at about 13:15 EAT and the audit
text's "13:43" retry (EAT) both agree with the UTC reading.

## Verdict

| Leg | Settled end to end by a real callback? | Evidence |
|---|---|---|
| Funding (STK Push, KSh 10) | **Yes.** Credited by a verified callback, ResultCode 0, 8.3 s after the request. | `funding-attempt.json` |
| Payout (B2C, KSh 10) | **Yes.** Marked paid by the B2C result callback, ResultCode 0, 5.2 s after Daraja accepted it. | `payout.json` |

Why each is a callback and not a status query, from the records:

- `queryCount` and `noAnswerCount` are 0 on both rows, and there are no
  `PaymentStatusCheck` rows for either, so the app never asked Daraja for a
  result.
- Each has one `PaymentCallback` row with outcome `applied`, ResultCode 0, one
  delivery. A callback row exists only for a request that passed the callback
  origin check (unsigned or forged callbacks get 401, see `../mpesa/`).
- The funding row's `resultCode` is set only by a callback (the schema says so
  and `confirmFunding` is called only from the callback handler). Its row, the
  deposit and the callback row are within 4 ms of each other.
- The payout amount equals the stored commission: KSh 100.00 x 10.00% = KSh
  10.00, and the callback reports 1000 cents.

## Funding leg

Funding attempt `cmwt418bz0001jj071w1rl095`, KSh 10.00, receipt ending SDPD.

| Time (UTC, EAT beside) | Event | Source |
|---|---|---|
| 10:15:39.877 UTC (13:15:39 EAT) | Attempt created, `queued`; audit event 960 `funding_requested` | FundingAttempt.createdAt, AuditEvent |
| (not recorded) | Sent to Daraja once (`sendCount` 1), which gave a MerchantRequestID and CheckoutRequestID; status `pending` | FundingAttempt |
| 10:15:48.169 UTC (13:15:48 EAT) | Status `confirmed`; deposit of KSh 10.00 created; audit event 961 `escrow_funded` | FundingAttempt.resolvedAt, EscrowDeposit, AuditEvent |
| 10:15:48.173 UTC (13:15:48 EAT) | Callback `stk` first received, outcome `applied`, ResultCode 0, "The service request is processed successfully.", amount 1000 cents, 1 delivery | PaymentCallback |
| 10:15:48.232 UTC (13:15:48 EAT) | Notification `funding_confirmed` | Notification |

## Payout leg

Disbursement `cmwt58lkx0005l408pwh7y6b3` for activation LF-000065, generation
1, KSh 10.00, receipt ending GGWK.

| Time (UTC, EAT beside) | Event | Source |
|---|---|---|
| 10:42:00.260 UTC (13:42:00 EAT) | LF-000065 submitted (events 965, 966). T0 could not be scored (timeout, 15000 ms) and the activation went to a reviewer (967, 968) | AuditEvent |
| 10:43:00.630 UTC (13:43:00 EAT) | T0 scored, advisory: band `auto_release`, probability 0.117 (event 969) | AuditEvent |
| 10:49:23.179 UTC (13:49:23 EAT) | Reviewer approved, reason "Verified evidence" (970); commission KSh 10.00 computed; payout authorised via daraja (971); disbursement created `queued` | AuditEvent, Commission, PayoutAuthorisation, Disbursement.createdAt |
| 10:50:02.677 UTC (13:50:02 EAT) | Daraja accepted the B2C instruction (`acceptedAt`, `sendCount` 1) | Disbursement |
| 10:50:07.837 UTC (13:50:07 EAT) | Status `paid`, ResultCode 0; audit event 972 `payout_paid` | Disbursement.resolvedAt, AuditEvent |
| 10:50:07.843 UTC (13:50:07 EAT) | Callback `b2c-result` first received, outcome `applied`, ResultCode 0, "The service request is processed successfully.", amount 1000 cents, 1 delivery | PaymentCallback |
| 10:50:07.894 UTC (13:50:07 EAT) | Notification `payout_paid` to the agent | Notification |

Request to payment: 44.7 s from approval. 39.5 s of that was the wait until
the scheduler sent the instruction (the payments cron runs every minute).

Two of the audit times above are the start of the run, not the moment of the
event: the T0 failure (968) happened at about 10:42:48 UTC and the T0 score
(969) at 10:43:45 UTC. See `cron-failure.md`.

## What the records do not show

- **No status history table exists.** The transitions above are rebuilt from
  timestamps on the rows. The moments a funding attempt moved `queued` to
  `sending` to `pending` are not recorded, only that it was sent once.
- **The receiving origin is not stored.** `PaymentCallback` has no host
  column. These rows are in the hosted Neon database, and the origin the app
  hands Daraja is the Vercel one (`../mpesa/callback-origin-and-unsigned.json`,
  16 November), but a Vercel request log for these two callbacks was not
  collected. Vercel Hobby keeps request logs for about 12 hours (see
  `../../../environment.md`).
- **Only the success path ran.** No failure, retry, status check or
  reconciliation happened in this test, so it says nothing about IR-03.
- **It is the Daraja sandbox and KSh 10 amounts**, not production M-Pesa.
- **Why the callbacks of 15 November never arrived is still not known.** Both
  legs here received theirs within seconds, which fits a delay on Safaricom's
  side on 15 November but does not prove it.

## How this was collected

Read only, from `app/` with the production settings pulled by `vercel env pull`
(not committed, never printed): every query ran inside `BEGIN READ ONLY` and
was rolled back, and nothing in the database was changed or retried. The rows
are the funding attempts and disbursements created after 2026-11-15 20:17 UTC
(23:17 EAT), which is one of each; any cutoff between that time and
2026-11-23 10:15 UTC (13:15 EAT) gives the same two. Audit events are the ones for the funding attempt's
requester in its time window, and every event of LF-000065.

Masking: receipts keep their last 4 characters; Daraja MerchantRequestID,
CheckoutRequestID and ConversationID keep their last 6; the callback
reference (part of the callback URL) is left out; no phone number is stored in
these files, and the one audit line that names the payout number holds it
masked as the app wrote it (`07******149`). Checked for digit runs of nine or
more, secrets, tokens and URLs: none.

## Files

| File | Contents |
|---|---|
| `funding-attempt.json` | The funding attempt, its callback, deposit, notification, audit events (960, 961), status checks (none) |
| `payout.json` | The disbursement, activation, commission, authorisation, callback, notification, status checks (none), and all eight audit events of LF-000065 (965 to 972) |
