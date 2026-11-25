# Defect 19: browser retest, 25 November 2026

Run on a local production build of branch `ui/signup-home-location` against a
freshly seeded scratch database (`ledgerfield_signup`), Chromium, at 18:01 UTC
(21:01 EAT). The names, numbers and emails typed are test values.
OpenStreetMap's tile and search hosts were never contacted: the one place
search was answered by a stand-in result inside the browser.

| Case (`browser-retest.json`) | Result |
|---|---|
| Agent sign-up with no location | No request sent, no account; "Choose where you are based..." shown (`signup-blocked-360.png`) |
| Sign-up with "Use my location" (-1.25, 36.88) | The request carries the same eight fields as before; stored values equal the ones shown |
| Place search on sign-up | 0 searches while typing, 1 on Enter; Enter did not submit the form; the chosen place filled the area name (`signup-chosen-360.png`) |
| Post a job with valid terms and no pin | No request sent, no job; the message shown (`job-blocked.png`), and the one under the map gone once a pin is placed |
