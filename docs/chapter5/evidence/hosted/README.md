# Hosted deployment evidence

Evidence from running Ledgerfield as a hosted system on 15 and 16 November
2026, and what each file shows. The hosted app is
`https://commission-app-ten-pied.vercel.app`; the services are listed in
`../../environment.md`, "Hosted deployment". All timestamps are UTC. Every file
was checked for secrets, phone numbers and local paths before it was
committed; identifiers that can carry a phone number are masked.

The demonstration database was filled by `app/scripts/seed-hosted.ts` (see
`seed/`), and every statement below is about that database. It is demo data:
the local setup (`scripts/demo-start`) remains the fallback.

## What each folder shows

| Folder | Shows | Does not show |
|---|---|---|
| `seed/` | Five seed runs against Neon from Nairobi, three failed (a transaction timeout, two lost connections) and the one that completed in 41 min 52 s with all 14 named cases landed | Why the connection closed (not established) |
| `scoring/` | Render first rebuilt its own model, which scored differently from the local one (`model-comparison.md`). After it served the published artifacts, 115 of 115 stored requests matched exactly on raw score, probability, band and thresholds (`model-match-after-redeploy.md`) | The CI (ubuntu) build was not compared, because the throwaway Linux build was not permitted; the cause of the platform difference is not established |
| `cron/` | The first scoring and anchoring runs: a T0 decision, 709 audit events anchored in one batch, and a T7 attempt by cron that could not be scored (no first-week activity had been reported) and went to a reviewer | |
| `step16/` | The role boundary (each role's own area 200, the others 307); a full submission through the API with three photos; T0 in the request (the whole accept, form and submit flow took 3.5 s); T7 from the cron job; photos read back byte for byte, also after a redeploy | |
| `anchoring/` | Deployment of `AuditAnchor` on Polygon Amoy, the batch's transaction (status success, block, fee 0.001478 POL), and `verify-LF-000050.json`: an activation's 10 events verified against the root on chain | Verification against Polygon mainnet (Amoy is a test network) |
| `ir09/` | Plain HTTP answers 308 to HTTPS for every path including POST; HTTPS responses carry HSTS; TLS 1.3, valid certificate | A packet capture; hops other than browser to Vercel |
| `mpesa/` | The callback origin the app builds, and that forged or unsigned callbacks get 401. `callback-delivery-experiment.md`: Daraja delivered callbacks to a tunnel and to the hosted origin within about 10 s, and Vercel blocked nothing | **Why the 15 November STK and B2C callbacks never arrived (unexplained, see below)** |
| `performance/` | NFR-01 on the hosted app (99.35% within 2 s, 100 users) and NFR-02 on the hosted scoring service. See its README for what is and is not comparable with the local figures | NFR-02 at the dataset's history size over the internet |

## M-Pesa: what was and was not shown

- Shown: the hosted origin accepts only correctly signed callbacks (401
  otherwise); Daraja reaches that origin; the app credits only by a verified
  callback.
- Not shown: a hosted STK Push or B2C payout settling through a real signed
  callback. The two STK Pushes of 15 November and one B2C payout were accepted
  by Daraja and no callback reached the app; one of the STK payments completed
  about 20 hours later on Safaricom's side and was reversed 50 minutes after
  that. The cause is not known. The app's handling of this is
  `../../defects.md` items 10 to 14.
- The local, tunnelled run of 8 November (`../mpesa/run-2026-11-08*`) remains
  the end-to-end demonstration.

## Changes that came out of it

| Item | Where |
|---|---|
| Render serves the exact local scoring artifacts, downloaded and checked by SHA-256 | `render.yaml`, `artifacts/scoring-artifacts-v1.tar.gz.sha256`, release `scoring-artifacts-v1` |
| Seed made reliable from a distant machine | `app/scripts/seed-hosted.ts`, `PRISMA_TRANSACTION_TIMEOUT_MS` in `app/src/lib/db.ts` |
| Payment status checks, reconciliation, masked audit text | PR 82, `../../defects.md` items 10 to 14 |

## Reproducing a measurement

From `app/`, with `.env.hosted` pulled by `vercel env pull .env.hosted
--environment=production --yes` (gitignored; never printed):

- Seed: `node node_modules/tsx/dist/cli.mjs scripts/seed-hosted.ts`
- Full submission flow: `APP_URL=<origin> npx tsx scripts/hosted-verify.ts run <out.json>`
- Model comparison: `node --env-file=.env.hosted node_modules/tsx/dist/cli.mjs scripts/compare-scoring.ts <out.json>`
- NFR-01: `APP_URL=<origin> node --env-file=.env.hosted node_modules/tsx/dist/cli.mjs scripts/load-test.ts <dir>`
- NFR-02: `node --env-file=.env.hosted node_modules/tsx/dist/cli.mjs scripts/measure-hosted-scoring.ts <out.json>`
- Callback experiment: `scripts/mpesa-callback-experiment.ts` (usage in its header)
