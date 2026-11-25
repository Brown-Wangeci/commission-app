# DR-11: retention and anonymisation, demonstrated locally, 25 November 2026

One run of the retention job through its own cron route, on a local seeded
database with `RETENTION_DAYS=1`. All times are UTC, with EAT (UTC+3) beside
them.

**The job has not been run against the hosted Neon database, by decision.**
It is deployed and reachable there; no cron job calls it. The hosted data is
this project's demonstration record.

## Verdict

**The off-chain record was anonymised and the audit chain was left exactly as
it was.** One settled submission past the limit lost its photos, its
identifiers and its free text, kept its scores and amounts, and every audit
event, hash and chain link was unchanged afterwards.

## The run

| | |
|---|---|
| File | `demo-run.json` (`app/scripts/demo-retention.ts`) |
| Ran at | 10:06:50 UTC (13:06:50 EAT) |
| App | local production build on `localhost:3100`, seeded by `prisma/seed.ts` |
| Setting | `RETENTION_DAYS=1`; cutoff 2026-11-24 10:06:50 UTC (13:06:50 EAT) |
| Submission | LF-000048, refused automatically at hold-close, settled 2026-11-15 for this run |
| Result | `eligible 1, anonymised 1, evidenceFilesDeleted 4, deferred 0, failed 0` |

The route is protected like the other three:

| Request | Answer |
|---|---|
| `POST /api/cron/retention` with no `Authorization` header | **401** |
| `POST /api/cron/retention` with `Bearer <CRON_SECRET>` | **200**, with the summary above |

## What changed on the record

| Field | Before | After |
|---|---|---|
| Evidence photo, fetched by a signed-in reviewer | **200** | **404**, the bytes are gone |
| `customerMsisdnMasked` | `07** *** 950` | `anonymised` |
| `customerMsisdnHash` | `3eb54525...` | a fresh random value |
| `deviceId` | `dev-samu...` | a fresh random value |
| GPS fix | -1.201724067637806, 36.91298979739217 | -1.2, 36.91 (about 1.1 km) |
| GPS accuracy | 8 m | null |
| Client's own evidence field | `{"field_1": [1,2,3,4], "field_2": "Kenya Mpya"}` | `{"field_1": [1,2,3,4], "field_2": null}` |
| Each photo row | file name, GPS fix, `locationSource: device` | `anonymised`, no fix, `locationSource: none` |
| Dispute reason | the refusal text | `anonymised` |
| `anonymisedAt` | null | the time of the run |

## What was kept

| Kept | Value on this submission |
|---|---|
| Both scores with their feature vectors and reasons | T0 `review` 0.398 with 18 feature fields, T7 `reject` 0.757 with 27, three reasons each |
| The first week of customer activity | 8 days |
| The reference, the state and the submission time | LF-000048, `refused`, 2026-10-23 |

This submission had no reviewer's reason, no evidence request, no agent note
and no payout: it was refused automatically, so those fields were already
empty and the report shows them unchanged. Those paths are covered by the
tests instead (TC-149 and TC-151, `app/tests/retention.test.tsx`), which build
a submission carrying every kind of free text and a paid payout, and check
that each one is cleared or masked.

## The audit chain, before and after

| | |
|---|---|
| Events for this submission | 9 before, 9 after |
| Every event id, kind, sequence, hash and detail | **unchanged** (`untouched: true`) |
| Verification | `partly_verified` before and after, with the same summary |

`partly_verified` is the right answer on this machine: every hash recomputes
and links, and no batch is anchored, because the local run has no chain
configured. Verification against a root actually recorded on chain, before
and after anonymisation, is TC-151 in the test suite, which anchors a batch on
a stand-in chain and checks the root still matches.

The run's own audit event carries counts only:

```
retention_anonymised: Retention run: 1 settled submission(s) anonymised after 1 day(s), 4 evidence file(s) deleted.
```

### The gap: what the chain still holds

Every detail still in the chain for LF-000048 is listed in `demo-run.json`.
On this submission they are all machine-written, but one of them shows the
problem plainly:

```
dispute_opened: Refusal recorded for audit and contest: Refused automatically at hold-close: ...
```

The same field holds whatever a reviewer or an agent typed on submissions
decided by a person. That text is append-only and anchored, so the retention
job cannot reach it. See `docs/RETENTION.md`, section 3, for why, and for the
design proposed instead.

## Masking

The seed's people, numbers and photos are fictional. The report is masked
anyway, as every committed evidence file is: phone numbers keep their last
three digits, any other run of nine or more digits becomes a count, and
identifier hashes are cut to eight characters. Checked before committing for
digit runs of nine or more, phone numbers, secrets and local paths: none.

## Reproducing

From `app/`, against a running local app on a seeded local database:

```sh
APP_URL=http://localhost:3000 RETENTION_DAYS=1 npx tsx scripts/demo-retention.ts out.json
```

The script refuses any `APP_URL` or `DATABASE_URL` that is not local. It
back-dates one submission's `updatedAt` so a short demonstration is possible,
and changes nothing else before the job runs.
