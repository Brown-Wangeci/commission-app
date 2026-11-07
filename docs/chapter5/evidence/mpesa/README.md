# M-Pesa sandbox evidence

Captured from the real Daraja sandbox (`sandbox.safaricom.co.ke`), not from the
mock used by the automated tests. Each file is one exchange, written by the
code that made it. Credentials, passwords, initiator names, callback
signatures, phone numbers and customer names are redacted before the file is
written; the repository's own value scan found no credential in these files.

## Status: the end-to-end run is not complete

The requirements name a sandbox demonstration for FR-06, FR-19 and IR-01. That
demonstration has **not** been achieved yet. No successful STK Push and no
successful B2C payment has been observed. What is here is real, and it is
partial. It should not be cited as the demonstration.

| Step | Real run | Result |
|---|---|---|
| STK Push initiated | Yes | Daraja accepted it (`ResponseCode` 0) |
| Callback received through the public tunnel | Yes | Delivered and verified, `ResultCode` 1037 |
| Balance credited | **No** | Correctly not credited: the payer did not respond |
| Submission approved | Yes, in the B2C leg | Decided by the real scoring service |
| B2C instruction accepted | Yes | Daraja accepted it (`ResponseCode` 0) |
| B2C result callback received | Yes | Delivered and verified, `ResultCode` 2001 |
| B2C disbursed | **No** | M-Pesa refused the initiator |

## 2026-11-07-stk-no-pin

A real STK Push of KSh 50.00 to Daraja's documented test number. Nothing was
simulated. Daraja accepted the request, and 26 seconds later delivered
`1037 No response from user`, because the test number has no handset to enter a
PIN. The attempt became `failed` with that reason, and the balance stayed at
KSh 0.00.

Daraja's checkout id ends with the payer's number, which is masked here. This
capture was taken before that masking existed and was corrected by hand: only
that one field changed.

## 2026-11-07-b2c-leg

**Funding in this run was simulated**, as `run-summary.json` states: no STK Push
was sent. Everything after funding is real. A submission was scored by the real
service and released at hold-close, and a B2C payment of KSh 50.00 was sent to
Daraja, which accepted it. Daraja then delivered `2001 The initiator information
is invalid`, and the disbursement became `failed` with that reason, was not
retried, and was raised to an administrator.

Daraja's documentation gives three causes for 2001: wrong API user name, wrong
encrypted password, or the wrong algorithm or certificate. The request carries
`PartyA` 174379, the same shortcode used for STK Push. Which cause applies here
has not been established.

## What these runs do show

- Authentication, the STK Push and B2C request formats, and the callback route
  all work against the real service.
- Daraja reaches the app through a tunnel, and real callbacks pass origin
  verification. An unsigned request through the same tunnel got a 401.
- The real callback bodies match what the parser and the mock expect.
- Two real failures were handled as designed: visible, with Daraja's reason,
  and with no money credited or instruction resent.

## To finish the run

1. Fix the initiator details so a B2C payment can succeed.
2. Set `MPESA_SANDBOX_PAYER_MSISDN` to a real Safaricom line, in the root `.env`.
3. Run the steps under "Capturing a real sandbox run" in `app/README.md`, and
   enter the PIN when the phone prompts.

The result goes in a new `run-<date>` folder here.
