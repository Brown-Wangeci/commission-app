# Retention and anonymisation (DR-11)

How long Ledgerfield keeps personal data, what it removes when that time is
up, what it cannot remove and why, and how to run and check the job.

DR-11: *"Personal data shall be retained only for the period required by the
dispute and appeal processes, after which records shall be anonymised while
preserving the aggregated data required for model retraining."*

## 1. The retention period

| Setting | Default | What it does |
|---|---|---|
| `RETENTION_DAYS` | `1095` (three years) | How long a settled submission keeps its personal data, counted from the day it settled. |
| `RETENTION_MAX_PER_RUN` | `200` | The most submissions one run anonymises. The rest wait for the next run. |

**The default is an assumption, not a figure from Kenyan law, a regulator or
the industry partner.** It was chosen as comfortably longer than any dispute
or appeal this system supports: the hold window is seven days, a refusal can
be contested once, and a contested refusal is decided by a reviewer. Three
years leaves a wide margin for a claim raised long after the fact. **Confirm
it against legal advice before the platform holds any real person's data**,
and record the decision here. Nothing in the code depends on the number.

The clock starts when the submission was last changed, which for a settled
submission is when it was settled (approved, refused or withdrawn). It is not
the submission date: a case that took a year to resolve keeps its data for the
full period after the resolution, not after the sign-up.

## 2. What is anonymised, and when

A submission is eligible when **all** of these hold:

- its state is `approved`, `refused` or `withdrawn` — never while a reviewer,
  an agent or a dispute still owes a decision;
- it has not been anonymised already;
- it last changed before the cutoff;
- it has no payout, or its payout is `paid`. A failed, unconfirmed or
  unsent payout is money still owed, so the record stays whole until it is
  settled.

| Removed | How |
|---|---|
| Evidence photos | Deleted from the store (Vercel Blob hosted, disk locally). The `EvidenceItem` rows stay, so the record still says how many files there were and what their hashes were; the bytes are gone. |
| Photo file names, capture places | `fileName` becomes `anonymised`; each photo's own GPS fix and accuracy are cleared. |
| Customer's number | `customerMsisdnHash` becomes a fresh random value and `customerMsisdnMasked` becomes `anonymised`. A random value, not a constant, so two anonymised records cannot be linked by it. |
| Submitting device | `deviceId` becomes a fresh random value, for the same reason. |
| The agent's note to the reviewer | Cleared. |
| The client's own evidence fields | Every typed value becomes null. A photo field keeps its list of evidence numbers, which identifies nobody. |
| Review reasons, evidence requests and replies, dispute notes | Cleared, or replaced by `anonymised` where the column cannot be null. |
| Notifications about the submission | Replaced with a fixed line. |
| The agent's payout number on the settled payment | Replaced by its masked form (`07******000`) on the authorisation and the disbursement. |
| The GPS fix | Rounded to two decimal places of a degree: about 1.1 km of latitude, and the same of longitude near the equator. The accuracy is cleared, since it no longer describes the stored point. |

| Kept | Why |
|---|---|
| Every score: probability, band, thresholds, model version, the stored feature vector and the top reasons | What retraining and the model card need. The feature vector is numbers computed at scoring time, not the raw record. |
| The commission, the amounts, the receipt and the escrow movements | The accounts, and NFR-07. |
| The state history, timestamps and the `LF-` reference | The record of what was decided. |
| The customer's first-week activity counts | An aggregate the hold-close model is trained on; it names nobody once the identifiers above are gone. |
| The agent's own profile, including their payout number | The agent is a current user who must still be paid. Retention of a user account is a separate question this job does not touch. |
| Everything in the audit log | See section 3. |

Two things that are deliberately **not** removed and are worth stating:

- The agent's and the client's identity on the record. The submission still
  says which agent made it and for which client. Removing that would make the
  commission record meaningless, and both are parties to the contract rather
  than incidental subjects.
- `simRegisteredAt`, the SIM's registration date. It is an input the model
  uses and does not identify anyone on its own.

There is a tension with **DR-07**, which requires every submission to retain
its capture timestamp and device location. After anonymisation the timestamp
is kept and the location is kept to about a kilometre rather than to the
metre. That is a deliberate reading of DR-07 and DR-11 together, and it is
recorded as such in `docs/chapter5/gaps.md`.

## 3. What stays in the audit log, and why

**The retention job never modifies, deletes or re-hashes an audit event.**

`AuditEvent` is append-only (a database trigger refuses `UPDATE` and
`DELETE`), every event is hash-chained to the one before it, and batches of
events are anchored on Polygon (`docs/chapter5/audit-chain.md`). Removing or
rewriting one event would break the recomputed hash, break every later link,
and leave the recomputed Merkle root unable to match the root already recorded
on chain. The audit trail would stop being evidence — which is the whole
reason it exists (FR-22, NFR-11, IR-04).

So the chain still holds, permanently:

| Field | What it can contain |
|---|---|
| `detail` on a `transition` event | The free text a reviewer or an agent typed: an approval or refusal reason, an evidence request, a contest note, a withdrawal reason, the note sent with an evidence reply. |
| `detail` on `evidence_requested`, `activation_withdrawn`, `dispute_opened` | The same text again. |
| `detail` on `payout_authorised` | The agent's payout number in masked form, `254******149`. |
| `detail` on `payout_paid` | The M-Pesa receipt. |
| `actorId` | The user id of the agent, reviewer or client who acted. |
| `activationId` | Which submission the event concerns. |

Where those texts describe a customer — "the customer says she never signed
up" — that description stays after the rest of the record is anonymised. The
lawful basis for keeping it is accountability and the establishment or defence
of legal claims: the audit trail is what proves who decided what, and why, in
a dispute over somebody's income.

Because that basis does not extend to anything a person chose to type, every
form whose text lands in the chain carries a visible notice asking for no
names, numbers or ID numbers, and saying the text is permanent. There is
deliberately **no automatic redaction**: silently rewriting the words a person
used would weaken the same record it is meant to protect, and a pattern match
would catch some numbers and miss others while giving false assurance.

### Proposed design, not built

The fix for a production system is to keep personal data out of the chain
rather than to remove it afterwards:

1. The free text stays in the ordinary table it already has (`ReviewItem.reason`
   and the rest), which the retention job can clear.
2. The audit event stores no text, only a salted commitment to it:
   `SHA-256(salt || text)`, with a per-event random salt kept beside the text.
3. The chain hashes the commitment, exactly as it hashes the text today, so
   the event is still tamper-evident and anchoring is unchanged. Anyone with
   the text and the salt can prove the chain committed to those words.
4. Erasure then means deleting the text and the salt. The commitment left in
   the chain is a hash of data nobody holds any more, so it names nobody.

This changes the canonical form in `docs/chapter5/audit-chain.md`, so it needs
a version `ledgerfield-audit-v2` and a migration path for events already
anchored under v1. It was not built here.

## 4. Running the job

A protected cron route, like the other three:

| Job | Method and URL | Suggested interval |
|---|---|---|
| Retention | `POST <origin>/api/cron/retention` | daily |

It needs `Authorization: Bearer <CRON_SECRET>`. Without the header it answers
401; when `CRON_SECRET` is unset, 404. A run stops starting new work at
`CRON_TIME_BUDGET_SECONDS` and leaves the rest for the next run. A single
submission that cannot be anonymised (a storage outage, say) is logged,
counted as `failed`, and does not stop the others; the next run tries again.

A successful run answers 200 with a summary:

```json
{"summary":{"retentionDays":1095,"cutoff":"...","eligible":3,"anonymised":3,
            "evidenceFilesDeleted":11,"deferred":0,"failed":0}}
```

Each run that anonymised something writes one audit event, `retention_anonymised`,
whose detail carries **counts only** — no reference, no identifier, no field
value — because that event is itself permanent.

### Order of work

1. The photo bytes are deleted first. If the database transaction then fails,
   the record is left unmarked and the next run does it again, which is
   harmless. Marking the record first could leave the photos behind for ever.
2. The database write is one transaction: the activation, its evidence rows,
   the free text, the payout numbers and the `anonymisedAt` mark.

### What the database enforces, not just the application

- `anonymisedAt` is write-once: a record cannot be un-anonymised.
- A submission's evidence payload is still fixed (DR-07), with one exception:
  the update that anonymises the record may replace every typed value with
  null, and nothing else.
- A paid disbursement's payout number may change only to its masked form.
  Every other part of the instruction is still frozen.

## 5. Checking it

- `app/tests/retention.test.tsx` (TC-148 to TC-151): a record past the limit is
  anonymised, one inside it is untouched, a second run changes nothing, the
  database refuses the changes above, the audit record verifies against its
  anchored root before and after with every event and hash unchanged, and the
  notice is on each form.
- `docs/chapter5/evidence/retention/`: a run on a local seeded database with
  `RETENTION_DAYS=1`, with the record before and after, the photo gone, and the
  audit chain shown unchanged.

Reproduce the demonstration locally, never against the hosted database:

```sh
cd app
APP_URL=http://localhost:3000 RETENTION_DAYS=1 npx tsx scripts/demo-retention.ts out.json
```

It refuses to run against any `APP_URL` or `DATABASE_URL` that is not local.

## 6. Not done

- The job has **not** been run against the hosted Neon database. It is
  deployed and reachable there; no cron job calls it, by decision, because the
  hosted data is the demonstration record for this project.
- There is no screen for an administrator to see or trigger retention, and no
  way to anonymise one record on request (a data subject's erasure request is
  not implemented).
- `User` and `Agent` accounts are out of scope: this job anonymises
  submissions, not the people who hold accounts.
- The retention period itself is unconfirmed (section 1).
