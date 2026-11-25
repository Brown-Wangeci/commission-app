# Hosted check: activations stored at 0, 0 (defect 20), 25 November 2026

`activation-counts.json`: one read-only query against the hosted Neon database
at 19:30:46 UTC (22:30:46 EAT), before the fix was merged. It ran inside a
single transaction set `READ ONLY` (confirmed as `transaction_read_only: on`)
and rolled back. It returns counts only. Nothing was changed.

| Table | Rows | With a location | At latitude 0 and longitude 0 | With either value 0 |
|---|---|---|---|---|
| Activation | 68 | 68 | **0** | 0 |
| EvidenceItem (photos and files) | 350 | 295 | **0** | 0 |

`live_database_check` confirms the connection reached the database the app uses:
it holds LF-000068, submitted by the map-picker check the same day.
