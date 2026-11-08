# M-Pesa sandbox evidence

Captured from the real Daraja sandbox (`sandbox.safaricom.co.ke`), not from the
mock used by the automated tests. Each file is one exchange, written by the
code that made it. Credentials, passwords, initiator names, callback
signatures, phone numbers and customer names are redacted before the file is
written; the repository's own value scan found no credential or phone number
in these files.

## Status: both legs achieved, for real, in the sandbox

The requirements name a sandbox demonstration for FR-06, FR-19 and IR-01. Both
are now demonstrated:

- **FR-06 (fund escrow by STK Push): achieved** in `run-2026-11-08`. A real
  phone received the prompt, entered its PIN, M-Pesa confirmed the payment
  with a real receipt, and the balance was credited only by that verified
  callback.
- **FR-19 / IR-01 (disburse by B2C): achieved** in
  `run-2026-11-08-b2c-retry`. A real B2C payment was accepted by Daraja and
  confirmed by a real result callback, `ResultCode 0`, receipt `UK8030FWVE`.

They are two separate captures because the Daraja sandbox cannot do both with
the same phone number: STK Push rings a real handset, so it needs a real
Safaricom number; B2C sandbox only pays a designated test customer, so it
needs the number from the app's own Test Credentials page
(`254708374149`), which has no real handset behind it. Together they
demonstrate both halves of IR-01.

| Step | Real run | Result |
|---|---|---|
| STK Push initiated | Yes | Daraja accepted it (`ResponseCode` 0) |
| Callback received through the public tunnel | Yes | Delivered and verified, `ResultCode` 0 |
| Balance credited | Yes | KSh 10.00, receipt `UK83J2S9JE` |
| Submission approved | Yes | Decided by a reviewer, from the real scoring service's T0 result |
| B2C instruction accepted | Yes | Daraja accepted it (`ResponseCode` 0) |
| B2C result callback received | Yes | Delivered and verified, `ResultCode` 0 |
| B2C disbursed | **Yes** | KSh 10.00, receipt `UK8030FWVE` |

## run-2026-11-08-b2c-retry (the successful B2C leg)

Funding in this run was simulated, as its `run-summary.json` states, so this
run proves the B2C leg on its own. Everything after that is real, for a KSh
10.00 instruction, `CommandID BusinessPayment`, unchanged from every earlier
attempt:

- A job was published, assigned, submitted, scored, and approved, the same as
  every other run here.
- The resulting B2C instruction, to `254708374149` (the Phone No on the
  sandbox app's own Test Credentials page), was accepted by Daraja and then
  confirmed by a real result callback: `ResultCode 0`, receipt `UK8030FWVE`,
  `B2CRecipientIsRegisteredCustomer: Y`.

This is the third real B2C attempt, and the only change from the second
(`run-2026-11-08`, below) was the recipient number. That confirms the
diagnosis of the `2040` refusal: the Daraja B2C sandbox pays its own
designated test customer, not an arbitrary real Safaricom number, even one
with a real handset that received a real STK prompt moments earlier in
another run.

## run-2026-11-08 (the successful funding leg)

One continuous run, nothing simulated, for amounts of KSh 10.00 throughout:

1. STK Push to a real Safaricom number: accepted, then a real callback 11
   seconds later, `ResultCode 0`, receipt `UK83J2S9JE`. The client's escrow was
   credited to KSh 10.00 by that callback alone; the initiating request itself
   credited nothing.
2. A job was published from that balance, assigned, submitted, scored by the
   real scoring service, and approved by a reviewer.
3. The approved commission (KSh 10.00) queued one B2C instruction, to the same
   real Safaricom number that paid the STK Push. Daraja accepted it, then a
   real result callback arrived with `ResultCode 2040`:
   `Credit Party customer type (Unregistered or Registered Customer) can't be
   supported by the service.` Resolved by `run-2026-11-08-b2c-retry`, above,
   which paid the sandbox's own test customer number instead.

## run-2026-11-07-b2c-leg (the 2001 attempt)

**Funding in this run was simulated.** The B2C leg was real: Daraja accepted a
KSh 50.00 payment, then refused it with `2001 The initiator information is
invalid`. That pointed at the B2C shortcode: it was the same shortcode used
for STK Push (174379), which does not match Daraja's B2C examples. Correcting
the B2C shortcode, initiator name and security credential removed the 2001;
the next attempt (`run-2026-11-08`) then reached 2040 instead, a different
cause (the recipient, not the credentials), finally resolved above.

## run-2026-11-07-stk-no-pin (superseded by run-2026-11-08)

A real STK Push of KSh 50.00 to Daraja's documented test number, before a real
phone was available. Daraja accepted the request, and 26 seconds later
delivered `1037 No response from user`, because the test number has no
handset to enter a PIN. Kept for the record; `run-2026-11-08` is the real
success for this leg.

## What these runs show together

- Authentication, the STK Push and B2C request formats, and the callback route
  all work against the real service, for both funding and disbursement, now
  each confirmed by a real success.
- Daraja reaches the app through a tunnel, and real callbacks pass origin
  verification. An unsigned request through the same tunnel got a 401.
- The real callback bodies match what the parser and the mock expect, across
  five distinct real result codes observed in order: `1037`, `2001`, `0`
  (funding), `2040`, `0` (disbursement).
- Every real failure along the way was handled as designed: visible, with
  Daraja's exact reason, money never credited or paid incorrectly, and nothing
  resent automatically. Each was fixed by changing one external thing
  (a real phone, the B2C shortcode, the recipient number), never by retrying
  the same call with no change.
- Daraja's `CheckoutRequestID` was found (in the first run) to end with the
  payer's number. It is masked in every capture.
- Normalising the payout number to local form before storing it, added after
  the first funding run, was checked against `toDarajaMsisdn` and confirmed
  to round-trip exactly to the international form Daraja's B2C examples use
  (`254...`); every captured `PartyB` above shows that format.
