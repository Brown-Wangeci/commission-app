# Hosted check: agents and jobs stored at 0, 0 (defect 19), 25 November 2026

`location-counts.json`: a read-only query against the hosted Neon database at
18:03:16 UTC (21:03:16 EAT), before the fix was merged. It ran inside a single
transaction set `READ ONLY` (confirmed as `transaction_read_only: on`) and
rolled back. It returns counts only; no name, number or coordinate was read
out. Nothing was changed.

| Table | Rows | At latitude 0 and longitude 0 | With either value 0 |
|---|---|---|---|
| Agent (`homeLat`, `homeLon`) | 7 | **0** | 0 |
| Job (`areaLat`, `areaLon`) | 10 | **0** | 0 |

`live_database_check` confirms the connection reached the database the app
uses: it holds the job the map-picker check posted earlier the same day
(`../ui-pass/map-job.json`). A first run of the same counts at 18:03:03 UTC,
without that confirmation, gave the same numbers.

Activations were not counted; see defect 19's open item in
`../../../defects.md`.
