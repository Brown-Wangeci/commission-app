# Defects 20 to 22: browser retest, 25 November 2026

Local production builds of branch `fix/defect-20-activation-location` against a
freshly seeded scratch database, Chromium. Names, numbers and emails typed are
test values. OpenStreetMap's tile and search hosts were blocked throughout, so
the maps have no tiles.

`browser-retest.json`, started 19:09:47 UTC (22:09:47 EAT). It ran after the pin
fix and before the two changes for defect 22, which alter only stacking and link
height and were checked separately (`map-checks.json`, the audit):

| Case | Result |
|---|---|
| Activation form, device gives no location, Submit pressed | No request sent, nothing stored; message and a 98 x 48 px Try again beside the button (`activation-blocked-360.png`) |
| Same form, Demo controls "Use the job area centre" | Boxes read-only; message gone; submitted; stored at the job centre (-0.0995, 34.768) |
| Device reports exactly 0, 0 | Treated as no location: nothing sent, boxes empty; after a real fix and Try again, stored at that fix; the photo added before it has no location |
| Direct API call with blank, then 0, 0 | 422 with the field error on gpsLat and gpsLon; nothing stored |
| Sign-up, coordinates typed | Off by default; bad text explained; cleared when unticked; outside Kenya warns and still creates the account with the typed values (`signup-manual-360.png`) |
| Post a job, coordinates and radius typed | Pin and circle appear, move to the typed point (circle centred in the map), halve with the radius, vanish for a bad value; map click writes the fields back; stored values equal the typed ones (`job-manual.png`) |

`map-checks.json`: the pin's position (defect 21, `pin-*.png`) and what is drawn
over the sticky bars (defect 22, `overlap-*.png`), before on the hosted app at
v1.2.2 (read only: no request that writes was allowed) and after on the local
build.

**On the hosted app after deployment** (v1.2.3, 19:4x UTC, 22:4x EAT): the same
two map checks were run read only. The pin's tip is on the circle's centre
(`pin-after-v1.2.3-hosted.png`) and no sample point over either sticky bar shows
the map (`overlap-after-v1.2.3-hosted-publishbar.png`). Defect 20's refusal was
not retried on the hosted app: that would mean sending a submission.
