# Where does Daraja deliver STK callbacks? A controlled experiment

Run on 2026-11-16 from a developer machine, against the Daraja sandbox,
using `app/scripts/mpesa-callback-experiment.ts`. It sends one STK Push of
KSh 1 to the sandbox payer with a chosen callback URL. It writes nothing to
the database and changes no payment code. Identifiers are masked: the
request-ID suffix, the receipt (first three characters kept), and this
machine's own address in the self-test line. No phone number, secret or
signature appears in these files.

## Why

On 2026-11-15 two hosted STK Push attempts of KSh 10 (13:08 and 13:17 EAT)
were accepted by Daraja, and no callback reached the hosted app. The first
one completed on Safaricom's side about 20 hours later (09:10 EAT on
2026-11-16) and was reversed at 10:00 EAT. The app received no callback for
it either, and it had marked the attempt failed after three status checks
(`../../../defects.md`, items 10 to 14, has the defects this exposed). Three explanations
were open: the sandbox was slow, Daraja does not deliver to this origin, or
Vercel blocked the requests.

## Result

| Test | Callback URL pointed at | Daraja accepted | Callback arrived | After | Result code |
|---|---|---|---|---|---|
| A | A temporary cloudflared tunnel to a local listener | 12:00:16Z | Yes, 12:00:25Z | 9 s | 0, processed successfully |
| B | The hosted origin (`commission-app-ten-pied.vercel.app`), with a signature the app refuses | 12:04:17Z | Yes, 12:04:29Z | 12 s | not read: the app answers 401 before the body |

- **A.** The request came from a Safaricom address (user agent
  `ReactorNetty/1.2.9`), carried the full STK result with its receipt, and
  the listener answered 200. STK Query agreed (`ResultCode` 0).
- **B.** Vercel's request log records the same user agent, `POST` on the
  callback path, answered **401** at the edge region `bom1`, with
  `wafAction: allow`. The 401 is the designed answer to a bad signature, and
  nothing was written to the database. Files: `testB-vercel-request-log.json`.
- In both tests the sandbox completed the payment by itself within seconds,
  before the payer could cancel, so each test may have debited KSh 1 on the
  payer's phone.

## What this establishes

1. **Vercel does not block Daraja.** The firewall has no rules, protection
   modes are off, 0 requests were denied, and a Daraja request to the
   `vercel.app` origin was allowed and answered (B).
2. **Daraja can deliver to the `vercel.app` origin**, as it can to a tunnel.
   No relay or second public origin is needed on this evidence.
3. **The missing 15 November callbacks are not a standing delivery fault.**
   When the sandbox processed a payment promptly, the callback arrived in
   about 10 seconds at either destination.

## What it does not establish

- Why the 15 November payment stayed in process for about 20 hours, or why no
  callback came when it finally completed. This looks like a delay on
  Safaricom's side (the status query answered 429, then `500.001.1001`, in the
  meantime), but the delay itself cannot be seen from here.
- Whether the sandbox would deliver a callback for a transaction that
  completes that late. None reached the app.
- Whether a real PIN-entry payment behaves like these two (the sandbox here
  completed them without waiting for the payer).
- Whether the reversal is sandbox-only. No Safaricom documentation was found
  on it.

## Consequence for the app

Whatever the cause on the sandbox side, the app must not depend on the
callback alone. This is why the status-check and reconciliation changes in
`../../../defects.md` (defects 10 to 12) were made.

## Files

| File | What |
|---|---|
| `testA-push.json` | Daraja's answer to Test A's push |
| `testA-listener-log.jsonl` | Requests the local listener recorded: the project's own self-test, then Daraja's callback |
| `testB-push.json` | Daraja's answer to Test B's push |
| `testB-vercel-request-log.json` | Vercel's record of Daraja's request to the hosted origin |
