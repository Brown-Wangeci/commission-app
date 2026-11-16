Hosted seed runs against Neon (eu-central-1), from a developer laptop in Nairobi.
Each Neon query from there took a median of 189 ms (20 queries, 184.9 to 228.1 ms), measured 2026-11-15.

attempt1-seed-output-old-render-model.txt
  2026-11-15T06:17:51Z to 06:49:17Z (31 min 26 s), pooled URL. Completed. 13 of 14 named cases;
  LF-000054 MISS. The Render service then rebuilt its own artifacts and scored differently
  (scoring/model-comparison.md). Superseded.
attempt2-failed-transaction-timeout.txt
  07:43:02Z to 07:48:22Z, pooled URL, after Render served the published artifacts. Stopped: an
  interactive transaction (a T7 decision with its payout) took 5197 ms, past Prisma's 5000 ms default (P2028).
attempt3-failed-connection-closed-pooled.txt
  07:49:52Z to 08:17:02Z, pooled URL, PRISMA_TRANSACTION_TIMEOUT_MS=30000. Stopped:
  P1017 "Server has closed the connection" after about 27 minutes.
attempt4-failed-connection-closed-direct.txt
  08:21:25Z to 08:50:46Z, direct (unpooled) URL, same timeout. Stopped: P1017 after about 29 minutes.
attempt5-seed-output-published-artifacts.txt
  08:51:25Z to 09:33:17Z (41 min 52 s), direct URL with connection_limit=1, same timeout.
  Completed. 14 of 14 named cases, "Every named case landed where intended." This is the data
  the hosted verification ran on.

Why the connection closed was not established. The single-connection run is the only change
that preceded a completed run after the two P1017 failures: consistent with stale idle
connections in Prisma's pool, not proof of it. Local paths in the stack traces are written <repo>.
The seed's settings for a remote run are in app/scripts/seed-hosted.ts.

The demo password printed by the seed at its end is written <demo password> in attempt1 and attempt5.
