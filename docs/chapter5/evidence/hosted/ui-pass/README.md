# Hosted check: the job-area map picker, 25 November 2026

`map-job.json` is the output of `app/scripts/hosted-verify.ts map-job`, run
against `https://commission-app-ten-pied.vercel.app` at production `8d87718`
(PRs #100 to #103; Vercel production deploy READY 15:41:40 UTC, 18:41:40 EAT),
from 15:51:15 UTC (18:51:15 EAT) to 15:51:30 UTC (18:51:30 EAT).

## What it did

1. As `client2@ledgerfield.test`, opened the post-a-job page in Chromium,
   filled the title, description and place name, and placed the job area with
   the map picker: a click on the map (pin at -1.268817, 36.866684), then
   **Use my location** with the browser's location set to -0.0995, 34.768
   (the point the API-driven steps post), then the radius slider to 1 km.
   It read the three values the picker put in the form (Advanced), typed the
   commission (KSh 1,000 at 1%, so the job locks only KSh 10.00), and pressed
   **Publish the job**.
2. Added the demonstration evidence fields through the client's evidence
   endpoint, assigned `mercy@` as `reviewer@`, and submitted one activation
   as `mercy@` through the API (accept, form, multipart submit, T0 scoring in
   the request), exactly as the earlier hosted steps do.
3. Opened the review screen as `reviewer@`. **No decision was made**: the
   activation is held until its hold window closes, as every activation with
   a T0 auto_release score is.

OpenStreetMap's tile and search hosts were blocked for the whole run (their
policies forbid automated clients), so no tile or search request was made;
the map accepted the click without tiles.

## Result

| Check | Value |
|---|---|
| Values the picker put in the form | `areaLat` -0.099500, `areaLon` 34.768000, `areaRadiusM` 1000 |
| Amount field after leaving it | `1,000` (thousands separator added on leaving the field; the job published) |
| Stored job area (from the review detail, read from the database) | -0.0995, 34.768, 1000 m |
| Stored equals the form's values | lat true, lon true, radius true |
| Same centre as the API-driven steps (`postJob`) | true |
| Activation | LF-000068, state `held` after submit |
| T0 decision | band `auto_release`, probability 0.1339 |
| Submission and photos outside the job area | 0 km; photos 0, 0, 0 km |
| Review screen | HTTP 200, "Where it happened" present; not decided |

## Compared with before

The activation behaves as the earlier hosted runs did: held after a T0
`auto_release` score, as LF-000063 (step 16, `../step16/run.json`, T0
auto_release 0.1170) and LF-000067 (`../client-review/review-on.json`, held
after T0). The probability differs from step 16 because the job's terms differ:
the same step run locally first with step 16's terms (KSh 2,500 at 12% plus
KSh 50) gave 0.11695906, the value step 16 recorded on hosted, and with this
run's terms (KSh 1,000 at 1%) gave 0.13392857, the value recorded here.

Nothing in the file is a phone number or a secret: it holds ids, the area, the
T0 decision with its reasons, and the app's address. Writes made on hosted:
one job (by its terms, KSh 10.00 locked from client2's escrow), one evidence configuration
version, one assignment and one activation, all through the app's own API and
page.
