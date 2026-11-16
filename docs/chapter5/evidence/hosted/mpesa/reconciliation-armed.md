# Reconciliation armed on the three hosted rows, 16 November 2026

Defect 12 (`docs/chapter5/defects.md`) added reconciliation: after the app
gives up on a payment, Daraja is still asked, slowly, for 48 hours. The three
payments below were made on 15 November, before that existed, so they had no
deadline and were never asked about again. At 13:42:43 UTC on 16 November a
deadline (`reconcileUntil`, +48 h) was set on exactly these three rows with
`app/scripts/arm-reconciliation.ts arm <id> ...`. The script writes only those
two fields, sends nothing to Daraja, and refuses any row that is not a failed
funding attempt with no result or a raised, unconfirmed payout. The hosted
payments cron (every minute, unchanged) then asked Daraja about each row at
13:43:00 UTC. The answers are in `reconciliation-status-checks.json`, one
`PaymentStatusCheck` row per check; the rows' state afterwards is in
`reconciliation-row-state.json` (receipts, request ids and phone numbers are
reduced to "present"/"none" or not stored at all).

## What Daraja reported

| Row | Made | Daraja's answer to the reconcile check | What the app did |
|---|---|---|---|
| STK KSh 10, `cmwhok68r...` (second push) | 15 Nov 13:17 EAT | HTTP 200, `ResultCode 17`, "Rule limited." (answered, counted) | Treated as an answered non-success: reconciliation closed (`reconcileUntil` cleared). Row stays failed. Nothing credited. |
| STK KSh 10, `cmwho9ob5...` (first push, the one the payer's phone shows debited then reversed) | 15 Nov 13:08 EAT | HTTP 429, "Daraja is unavailable (HTTP 429)" (not answered, **not counted**) | Recorded with `countedAsCheck = false`; next check scheduled for 14:43 UTC (one hour). The row is still being reconciled. |
| B2C KSh 10, LF-000064, `cmwi9zaq9...` | 15 Nov 23:16 EAT | HTTP 200, query accepted, no result in the body (a payout's result arrives by callback) | Recorded as an accepted query; next check scheduled for 14:43 UTC. Still `unconfirmed`, still being reconciled. |

## What this shows, and what it does not

- Shown, against the real Daraja sandbox from the hosted app: a row made
  before the feature is asked about once armed; every answer is stored, one row
  each, with Daraja's own code and words; an HTTP 429 is recorded but does not
  use up a check and schedules the next one an hour on (defects 10, 11, 12); a
  definite answer closes a funding reconciliation; nothing was sent twice and
  nothing was credited or paid by a status check.
- Not shown: the case reconciliation exists for, Daraja saying `ResultCode 0`
  for a payment the app marked failed, raised to administrators with nothing
  credited. On 16 November Daraja answered `0` for the first push when asked by
  hand (`../../../defects.md`, item 10 to 14), but on this check it answered
  429 and the follow-up is an hour away. If the later checks answer `0`, they
  will be appended to the check table; this folder holds the state at
  13:43 UTC only.
- Not shown: a payout's late result. It arrives only by callback.
- Daraja's answer "Rule limited." (code 17) for the second push is reported as
  received; its meaning is not documented here and no cause is claimed.
