# Hosted performance: NFR-01 and NFR-02

Measured 2026-11-16 against the hosted system, from a developer laptop in
Nairobi, so every number includes the network between Nairobi and Frankfurt
(a measured round trip of about 0.23 s to the scoring service). The matching
local measurements, over loopback on the same laptop, are in
`../../performance/` and are not replaced by these.

## NFR-01: 100 concurrent users, routes with no external dependency

`app/scripts/load-test.ts`, unchanged, run with `APP_URL` set to the hosted
app. The same three routes as the local run (client escrow, admin review
queue, admin audit record), 100 concurrent virtual users, 30 s.
Raw output: `nfr01-load-test.json`.

| | Hosted (Vercel fra1, Neon, from Nairobi) | Local (loopback), 2026-11-09 |
|---|---|---|
| Requests | 4,280 | 5,761 |
| Errors | 0 | 0 |
| Within 2 s | 4,252 (99.35%) | 5,761 (100.00%) |
| Mean | 703.1 ms | 523.6 ms |
| p50 | 589.4 ms | 457.2 ms |
| p95 | 1,276.4 ms | 1,014.8 ms |
| p99 | 1,844.3 ms | 1,690.2 ms |
| Max | 2,486.6 ms | 1,809.9 ms |

**Target MET** (95% within 2 s): 99.35% hosted.

What this does and does not show:

- One client machine generated all the load, over one internet connection. It
  is not 100 separate users on mobile data, which is NFR-01's own stated
  scenario.
- The app ran on Vercel's free (Hobby) plan and the database on Neon's free
  plan. The 28 requests over 2 s were spread across all three routes (26 on
  the escrow route, 1 on each of the others).
- Cold starts were not separately measured.

## NFR-02: scoring within 1 s per submission

Two things were tried, and the first did not work.

**1. The local method does not work over the internet.**
`scripts/measure_scoring_latency.py` sends each activation's full 90-day
history from the synthetic dataset: 7 to 34 MB per request in a probe of three
activations. From Nairobi the upload alone took 22 to 150 s and then timed out,
so it measures the uplink, not the service. The attempt is kept in `nfr02-local-method-over-wan.txt`. The
script now reads `SCORING_SERVICE_URL` (default: local, unchanged) and records
the date it ran, but it is not used for the hosted figures.

**2. Requests the app itself builds from the hosted database.**
`app/scripts/measure-hosted-scoring.ts` (read-only) builds the stored request
for every activation in the hosted database (T0 for each, T7 where one can be
built: 118 requests, 1.8 to 16.2 KB) and sends each one at a time, twice.
Raw output: `nfr02-scoring-latency-hosted.json`.

| | n | mean | p50 | p95 | p99 | max | within 1 s |
|---|---|---|---|---|---|---|---|
| Round trip from Nairobi to the scoring service (Render, Frankfurt) | 236 | 0.436 s | 0.413 s | 0.541 s | 0.617 s | 0.736 s | 236 (100%) |
| Network alone: `GET /health` from the same machine | 30 | 0.255 s | 0.227 s | 0.512 s | 0.524 s | 0.524 s | 30 (100%) |
| Calls the deployed app made itself, Vercel to Render (`ScoringAttempt.durationMs`) | 5 | 0.293 s | | | | 0.346 s | 5 (100%) |

- With demonstration-sized requests, the hosted scoring path is well inside
  1 s, including the network from Nairobi.
- The 5 app-originated calls are all the app had made since the seed finished,
  as of this measurement: four T0 (two from the first scoring cron run, two
  from submissions) and one T7 from the cron job. That is too few to give a
  percentile, and they are listed individually in the JSON.
- **Not comparable with the local figure.** The local 1.66 s mean (and the
  NFR-02 "not met") comes from requests carrying megabytes of history (7 to 34 MB in the
  probe), which cost a median 1.4 s even over loopback. The hosted requests are 1.8 to 16.2 KB
  because the hosted database is small. How the hosted service behaves with a
  history of the dataset's size is **not measured**, and it is the case the
  local run was built to test.
- Render's free instance spins down when idle. The measurements ran against an
  awake instance (it answered `/health` promptly just before). The first
  request after a spin-down is slower and was not measured.
