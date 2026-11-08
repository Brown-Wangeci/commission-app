# M-Pesa sandbox evidence

Captured from the real Daraja sandbox (`sandbox.safaricom.co.ke`), not from the
mock used by the automated tests. Each file is one exchange, written by the
code that made it. Credentials, passwords, initiator names, callback
signatures, phone numbers and customer names are redacted before the file is
written; the repository's own value scan found no credential or phone number
in these files.

## Status: funding is demonstrated; disbursement is not

The requirements name a sandbox demonstration for FR-06, FR-19 and IR-01.

- **FR-06 (fund escrow by STK Push): achieved.** `run-2026-11-08` is a real,
  successful, end-to-end run: a real phone received the prompt, entered its
  PIN, M-Pesa confirmed the payment with a real receipt, and the balance was
  credited only by that verified callback.
- **FR-19 / IR-01 (disburse by B2C): not achieved.** The same run queued a real
  B2C payment and received a real result callback, but M-Pesa refused it with
  `ResultCode 2040`. No successful B2C payment has been observed in any run.

| Step | Real run | Result |
|---|---|---|
| STK Push initiated | Yes | Daraja accepted it (`ResponseCode` 0) |
| Callback received through the public tunnel | Yes | Delivered and verified, `ResultCode` 0 |
| Balance credited | **Yes** | KSh 10.00, receipt `UK83J2S9JE` |
| Submission approved | Yes | Decided by a reviewer, from the real scoring service's T0 result |
| B2C instruction accepted | Yes | Daraja accepted it (`ResponseCode` 0) |
| B2C result callback received | Yes | Delivered and verified, `ResultCode` 2040 |
| B2C disbursed | **No** | M-Pesa refused the recipient |

## run-2026-11-08 (the complete, successful funding leg)

One continuous run, nothing simulated, for amounts of KSh 10.00 throughout
(within the KSh 1-10 instructed for every real call in this round):

1. STK Push to a real Safaricom number: accepted, then a real callback 11
   seconds later, `ResultCode 0`, receipt `UK83J2S9JE`. The client's escrow was
   credited to KSh 10.00 by that callback alone; the initiating request itself
   credited nothing.
2. A job was published from that balance, assigned, submitted, scored by the
   real scoring service, and approved by a reviewer.
3. The approved commission (KSh 10.00) queued one B2C instruction. Daraja
   accepted it, then a real result callback arrived with `ResultCode 2040`:
   `Credit Party customer type (Unregistered or Registered Customer) can't be
   supported by the service.` The disbursement became `failed` with that
   reason and was not retried: this is a business-level refusal delivered by
   Daraja after acceptance, not a network or credential failure, and the code
   never retries a result Daraja has already given.

Per the earlier 2001 failure (`run-2026-11-07-b2c-leg`, simulated funding,
below), the B2C shortcode, initiator name and security credential were
corrected in the sandbox app's configuration. That fixed 2001. This run's 2040
is a different, more specific refusal: Daraja's own documentation reads "The
customer is not registered," meaning the recipient number is not accepted by
this sandbox app as a receivable B2C customer.

**This was reported rather than retried with different parameters, as
instructed.** No further attempt was made in this session.

## run-2026-11-07-stk-no-pin (superseded by run-2026-11-08)

A real STK Push of KSh 50.00 to Daraja's documented test number, before a real
phone was available. Daraja accepted the request, and 26 seconds later
delivered `1037 No response from user`, because the test number has no
handset to enter a PIN. Kept for the record; `run-2026-11-08` is the real
success for this leg.

## run-2026-11-07-b2c-leg (superseded for the credential question; the 2040 is new)

**Funding in this run was simulated**, as its `run-summary.json` states: no STK
Push was sent. The B2C leg was real: Daraja accepted a KSh 50.00 payment, then
refused it with `2001 The initiator information is invalid`. That pointed at
the B2C shortcode: it was the same shortcode used for STK Push (174379),
which does not match Daraja's B2C examples. Correcting the B2C shortcode,
initiator name and security credential removed the 2001; `run-2026-11-08`
then reached a different refusal (2040), so the credentials were not the only
issue.

## What these runs show together

- Authentication, the STK Push and B2C request formats, and the callback route
  all work against the real service, for both funding and disbursement.
- Daraja reaches the app through a tunnel, and real callbacks pass origin
  verification. An unsigned request through the same tunnel got a 401.
- The real callback bodies match what the parser and the mock expect, across
  four distinct real result codes now observed (`0`, `1032` never seen live but
  tested, `1037`, `2001`, `2040`).
- Funding is proven real and correct, start to finish, on the first continuous
  attempt after a phone was available.
- Three real B2C failures were each handled as designed: visible, with
  Daraja's exact reason, money never credited or paid incorrectly, and nothing
  resent automatically.
- Daraja's `CheckoutRequestID` was found (in the first run) to end with the
  payer's number. It is masked in every capture, including this run's.

## Still needed to close this out

`ResultCode 2040` says the sandbox does not accept this recipient as a
"registered" or "unregistered" customer it can pay. Possible next steps, none
attempted here:

- Check whether the Daraja sandbox restricts B2C recipients to specific test
  MSISDNs issued with the app, rather than any real Safaricom number.
- Try a different `CommandID` (`SalaryPayment` or `PromotionPayment`) against
  the same recipient, since Daraja's documentation ties the error to "Credit
  Party customer type," which varies by command.
- Ask Safaricom developer support what a B2C sandbox app needs for its
  recipient to be accepted.

Whichever is tried, it changes `MPESA_B2C_COMMAND_ID` or the recipient only,
and should produce a new, real result code to record here.
