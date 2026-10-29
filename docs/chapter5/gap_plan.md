# Requirements gap plan

**Status after Build 1 (issues #40 to #43):** WP2 is done. FR-07, FR-18,
FR-20, NFR-07 and DR-08 are met with tests; FR-04 keeps only its deadline gap;
NFR-14 keeps only its CI gap; FR-19 now authorises the computed commission
but still disburses nothing; DR-10 has the feature-vector groundwork and
stays a deviation. The CSV is current (16 met, 17 partially met, 22 not met,
4 not verifiable; 309 hours remaining). The ranking below is the original
plan and has not been recomputed.

Companion to `docs/chapter5/requirements_traceability.csv`. It groups the 48
requirements that are not met (24), partially met (20) or not verifiable (4)
into the work that would close them, and ranks that work by requirements
closed per hour. The 11 met requirements are not in the plan.

## How to read the numbers

- Hours are my estimates for one developer who already knows this codebase.
  They exclude waiting on third parties (Safaricom sandbox approval, testnet
  funds, hosting accounts), Chapter 5 writing, and review time.
- In the CSV, shared foundations are costed once, on one named row, so the
  effort column sums to the real remaining total (351 hours) without double
  counting. A package's hours are the sum of its rows.
- "Closed" is counted in the package that holds the requirement's row. Where a
  requirement also needs another package, the Depends column says so.
- No test or measurement was rerun this session. "Met" rests on tests that
  exist and on the pass count in `app/BUILD_LOG.md` (137 of 137 at commit
  c43ad16). The Python suite was not run.

## Ranking by requirements closed per hour

| Rank | Package | Hours | Closes | Per hour | Requirements | Depends on |
|---|---|---|---|---|---|---|
| 1 | WP13 Amend Chapter 4 wording | 7 | 4 | 0.571 | DR-01, DR-03, DR-04, IR-06 | Your approval; DR-01 needs your Section 2.2 references |
| 2 | WP8 Test and CI hardening | 15 | 5 | 0.333 | FR-02, FR-10, FR-17, DR-09, NFR-14 | NFR-14 closes fully only after WP2 |
| 3 | WP9 Notifications and privacy | 9 | 2 | 0.222 | FR-23, NFR-13 | FR-23 "paid" case needs WP1 |
| 4 | WP10 Job lifecycle gaps | 15 | 3 | 0.200 | FR-04, FR-08, FR-24 | Appeal period value from you |
| 5 | WP14 Model quality | 6 | 1 | 0.167 | NFR-08 | Closes only by amending the requirement |
| 6 | WP7 Deploy and measure | 26 | 4 | 0.154 | NFR-01, NFR-02, IR-07, IR-09 | Your hosting account; IR-07 needs NFR-02 result |
| 7 | WP2 Money model and commission | 34 | 5 | 0.147 | FR-07, FR-18, FR-20, NFR-07, DR-08 | Your decision on the commission rules |
| 8 | WP6 Mobile usability | 14 | 2 | 0.143 | NFR-12, IR-10 | None |
| 9 | WP3 Per-job evidence configuration | 36 | 5 | 0.139 | FR-05, FR-09, FR-12, DR-06, DR-07 | Design decision on fixed vs configurable fields |
| 10 | WP5 Offline PWA | 28 | 3 | 0.107 | FR-11, NFR-03, IR-08 | None |
| 11 | WP4 Audit hashing and Polygon anchoring | 49 | 5 | 0.102 | FR-21, FR-22, NFR-11, IR-04, IR-05 | Testnet wallet and RPC access |
| 12 | WP11 Phone verification | 10 | 1 | 0.100 | FR-01 | SMS provider account |
| 13 | WP1 M-Pesa Daraja payments | 62 | 6 | 0.097 | FR-06, FR-19, NFR-04, IR-01, IR-02, IR-03 | Sandbox credentials; FR-19 needs WP2 |
| 14 | WP15 Retention and anonymisation | 16 | 1 | 0.062 | DR-11 | Retention period from you |
| 15 | WP12 Retraining loop | 24 | 1 | 0.042 | DR-10 | Feature snapshots stored first |

Total: 351 hours.

## Read the ranking with three caveats

1. **WP13 and WP14 do not make the system do more.** They close a requirement
   by changing what it says (DR-03, DR-04, IR-06, and NFR-08) or by documenting
   it (DR-01). They are cheap because no product changes. Whether they count
   as closed is your call and your supervisor's, not mine.
2. **WP7 closes to "verified", not to "met".** NFR-01 and NFR-02 become
   measurable; either could still fail.
3. **The ranking is by count, not importance.** WP1 and WP2 rank low but hold
   the requirements the product exists for: money moving and commission being
   calculated. Ranking WP1 and WP2 by count undersells them.

## Suggested order

WP8, then WP9 and WP10 (cheap, no outside dependencies), then WP2 before WP1
because disbursement needs the cents model and a commission amount. After that
WP3, WP5, WP4, WP7, WP6 in whatever order the demonstration needs. WP13 can
run in parallel as soon as you decide on the wording. WP12 and WP15 last.

## Work packages

### WP13 Amend Chapter 4 wording (7 h)
- DR-03: replace 70:15:15 stratified with the agent-grouped, time-ordered
  design actually used (2 h). CLAUDE.md forbids random row splits.
- DR-04: record that SMOTE is implemented, leakage-tested, evaluated, and not
  used in the deployed model (1 h).
- IR-06: change "feature vector" to the event-log contract (1 h).
- DR-01: map each typology to a Section 2.2 source (3 h). I will not supply
  citations; this needs your reference list.

### WP8 Test and CI hardening (15 h)
- FR-02: test that a wrong password is rejected (2 h).
- FR-10: test that location and timestamp are stored; stop accepting
  hand-typed location outside demonstration mode (3 h).
- FR-17: test that an empty reason is rejected; add a database CHECK (2 h).
- DR-09: append-only trigger on AuditEvent and an update-attempt test (3 h).
- NFR-14: CI workflow that runs the app and Python suites and blocks merge on
  failure (5 h). There is no `.github` directory today.

### WP9 Notifications and privacy (9 h)
- FR-23: notify on automatic T7 release and refusal, which skips `notify`
  today (3 h). "Paid" waits for WP1.
- NFR-13: mask the agent payout number on four admin screens; reveal it, with
  an audit event, when resolving a dispute or failed payout (6 h).

### WP10 Job lifecycle gaps (15 h)
- FR-04: job deadline, enforced at accept and submit (4 h).
- FR-08: open-jobs list and agent self-accept (8 h). Today an administrator
  assigns every job.
- FR-24: appeal window in config, enforced on contest (3 h). The length is an
  assumption you must supply.

### WP14 Model quality (6 h)
NFR-08 cannot be closed by engineering effort. Measured T7: best-achievable F1
0.652, recall at 90% precision 0.424, and precision at 90% recall 0.243. F1 of
0.85 with recall of 0.90 needs precision of at least 0.805. The synthetic data
overlaps by rule (CLAUDE.md), so raising these numbers would mean making
fraud separable, which the project forbids. The 6 hours are for adding F1 to
`src/eval/metrics.py` and the results table so it is reported from committed
files, and for rewording the requirement (for example to the recall at fixed
precision and cost-based bands the project already reports).

### WP7 Deploy and measure (26 h)
- IR-09: hosted deployment (issue #19), TLS, HSTS, network capture (12 h).
- NFR-01: load test, 100 concurrent users, non-external routes (8 h).
- NFR-02: score-and-explain latency over the test set; define "deployment
  hardware" (3 h).
- IR-07: set the scoring timeout from the NFR-02 result (3 h). It is 15 s today.

### WP2 Money model and commission engine (34 h)
- DR-08: migrate money to integer cents across schema, call sites, formatting
  and the scoring boundary (10 h).
- FR-18: commission rules and an integer calculation with tests (10 h). **You
  must define the rules first.** Today the payout is a flat amount per
  activation and `commissionRate` is never applied.
- FR-07: lock maximum liability at publication, refuse an unfunded publish (6 h).
- FR-20: close-job action that returns unspent escrow (5 h).
- NFR-07: arithmetic test; remove the Float money column (3 h).

### WP3 Per-job evidence configuration (36 h)
- FR-05: configuration model and client builder (16 h).
- FR-09: render the agent form from it (10 h).
- FR-12: validate against it (5 h).
- DR-06: JSON storage for configuration and payload (3 h).
- DR-07: version the configuration and store its id on the activation (2 h).
The scoring contract needs a fixed set of base fields, so configurable fields
would sit beside them, not replace them.

### WP5 Offline PWA (28 h)
- IR-08: manifest, service worker, shell cache (14 h).
- FR-11: local queue with an idempotency key on submission (10 h).
- NFR-03: demonstration with the network disabled (4 h).

### WP4 Audit hashing and Polygon anchoring (49 h)
- FR-21: canonical event payload, hash, contract, deployment, client (22 h).
- IR-04: testnet integration, transaction id stored (8 h).
- IR-05: anchoring queue that never blocks submission or payout (8 h).
- FR-22: retrieve and verify, for all three roles (8 h).
- NFR-11: reproducibility test from the stored payload (3 h).

### WP6 Mobile usability and accessibility (14 h)
- NFR-12: 48 px targets (buttons are 38 px and 30 px today) and a 360 px check
  on a handset (8 h). Worth checking the 48 px figure against the standard
  cited: WCAG 2.1 target size is 44 by 44 CSS pixels at Level AAA.
- IR-10: automated and manual accessibility audit (6 h).

### WP11 Phone verification (10 h)
- FR-01: OTP via an SMS provider, account inactive until verified.

### WP1 M-Pesa Daraja payments (62 h)
- FR-06: Daraja authentication, STK Push, callback route (20 h).
- FR-19: settlement redesign (issue #14) and disbursement (14 h).
- IR-03: payment queue, bounded retry, administrator escalation (12 h). The
  scoring job table is a usable template.
- IR-01: B2C and the sandbox demonstration (8 h).
- IR-02: callback origin check and de-duplication (4 h).
- NFR-04: repeated-callback test (4 h).

### WP15 Retention and anonymisation (16 h)
- DR-11: retention setting, anonymisation job that keeps aggregates, test.
  The retention period is a legal value; it goes in config as an assumption
  for you to confirm.

### WP12 Retraining loop (24 h)
- DR-10: store the feature vector with each decision, export review outcomes
  as labels, and a retraining job. Review outcomes are selection-biased:
  only the review and escalated bands reach a reviewer.

## Decisions needed from you before building

1. What the commission rules are (FR-18).
2. Whether evidence fields are configurable beside the fixed scoring fields (FR-05).
3. Which requirement wordings to amend (WP13, NFR-08).
4. The appeal period (FR-24) and the retention period (DR-11).
5. Hosting, Safaricom sandbox, SMS provider and testnet accounts.
