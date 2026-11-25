# Chapter 5 screenshots after the UI pass, 25 November 2026

Captured with `app/scripts/capture-screenshots.ts` (committed, unchanged
apart from blocking the map services) against a production build of `main`
at `8d87718` (PRs #100 to #103), started locally with `npm start` against a
freshly seeded scratch database (`ledgerfield_shots`). All 16 figures and the
six usability captures keep their file names; none was skipped
(`capture-log.txt`). The earlier captures in the folder above are left in
place, so each figure can be swapped one for one.

OpenStreetMap's tile and search policies forbid automated clients, so the
script loads no map tile and runs no place search: a map in these captures
shows its zoom buttons, radius and attribution on a plain background. The map
figures are listed at the end for capture by hand.

The seed is the same script as on 16 November; references, dates and balances
come from this run's seed and differ slightly from the earlier captures. That
is not caused by the pass.

## Recaptured after the sign-up location change (defect 19)

`figure-5-11-validation-signup-duplicate-email.png` and
`usability/usability-04-signup-password-rules.png` were captured again on 25
November 2026 from a local production build of branch
`ui/signup-home-location`, fresh seed (`ledgerfield_signup`), map services
blocked. Figure 5.11 is pixel for pixel the same: it signs up a client
business, whose form has no location. Usability-04 changed: the agent form
under the password rules now has the place search, "Use my location", the
chosen-location line, the area name and "Advanced" in place of the typed
latitude and longitude. The other captures are still the ones from `8d87718`.

## Old figure -> new file

| Report figure | Old file (`../`) | New file (this folder) | What the pass changed in it |
|---|---|---|---|
| 5.1 | `figure-5-01-agent-status-list.png` | `figure-5-01-agent-status-list.png` | Nothing visible at 1360 px. On a phone the rows are now labelled cards (not in this desktop figure). |
| 5.2 | `figure-5-02-admin-review-queue.png` | `figure-5-02-admin-review-queue.png` | Nothing. |
| 5.3 | `figure-5-03-admin-review-mockup-case.png` | `figure-5-03-admin-review-mockup-case.png` | Nothing at 1360 px (the decision bar fixed at the foot applies at 640 px and below). |
| 5.4 | `figure-5-04-awaiting-evidence.png` | `figure-5-04-awaiting-evidence.png` | Nothing. |
| 5.5 | `figure-5-05-could-not-be-scored.png` | `figure-5-05-could-not-be-scored.png` | Nothing. |
| 5.6 | `figure-5-06-client-escrow-and-jobs.png` | `figure-5-06-client-escrow-and-jobs.png` | Escrow is one card (Available large, Deposited and Committed beside it) instead of three tiles; the funding form shows KSh inside the amount box; the funding list shows the latest three attempts. |
| 5.7 | `figure-5-07-client-job-detail.png` | `figure-5-07-client-job-detail.png` | "Edit evidence fields" is a quiet button. The four amounts are unchanged at 1360 px (2 x 2 on a phone). |
| 5.8 | `figure-5-08-payouts-with-failure.png` | `figure-5-08-payouts-with-failure.png` | The list shows its first 25 rows and a "Show all 48 payouts" button; the failed payout still comes first. |
| 5.9 | `figure-5-09-audit-log-with-anchoring.png` | `figure-5-09-audit-log-with-anchoring.png` | Nothing. |
| 5.10 | `figure-5-10-dispute-verification-result.png` | `figure-5-10-dispute-verification-result.png` | Nothing. |
| 5.11 | `figure-5-11-validation-signup-duplicate-email.png` | `figure-5-11-validation-signup-duplicate-email.png` | "I am" is a segmented control (An agent / A client business). |
| 5.12 | `figure-5-12-validation-empty-job-form.png` | `figure-5-12-validation-empty-job-form.png` | **Map figure (see below).** The job area is the map picker (place search, map, Use my location, Put the pin at the map centre, radius slider, values under Advanced); the review choice is three option cards; the evidence paragraph is one line plus "How evidence fields work"; KSh and % sit inside the money boxes. |
| 5.13 | `figure-5-13-validation-not-found.png` | `figure-5-13-validation-not-found.png` | Nothing. |
| 5.14 | `figure-5-14-validation-forbidden-role.png` | `figure-5-14-validation-forbidden-role.png` | The client home page the figure shows has the escrow card (as 5.6). |
| 5.15 | `figure-5-15-agent-submission-form.png` | `figure-5-15-agent-submission-form.png` | A location line at the top ("Your location was not found" in this headless run, with Try again); capture method as option cards; ID document as a segmented control; photos as take-photo tiles; coordinates and simulated device details under a closed "Demo controls"; "This activation" / "What this job needs". |
| 5.16 | `figure-5-16-agent-submission-form-mobile.png` | `figure-5-16-agent-submission-form-mobile.png` | As 5.15 at 360 px, with the Submit button held at the bottom of the screen. |
| (usability) | `usability/usability-01-admin-dashboard.png` | `usability/usability-01-admin-dashboard.png` | No header "Open the review queue" button; a repeat of the same link in the attention list is a text link. |
| (usability) | `usability/usability-02-admin-jobs.png` | `usability/usability-02-admin-jobs.png` | Nothing. |
| (usability) | `usability/usability-03-review-sections-open.png` | `usability/usability-03-review-sections-open.png` | Nothing at 1360 px. |
| (usability) | `usability/usability-04-signup-password-rules.png` | `usability/usability-04-signup-password-rules.png` | Segmented role choice, as 5.11; the base location is a place search and "Use my location" (recaptured, see above). |
| (usability) | `usability/usability-05-post-job-form.png` | `usability/usability-05-post-job-form.png` | **Map figure (see below).** The post-a-job form as loaded, with the map picker. |
| (usability) | `usability/usability-06-agent-home-360.png` | `usability/usability-06-agent-home-360.png` | No "My activations" button (it is the second tab); the job leads with "Pays KSh 10.00"; notifications follow the jobs. |

In 5.15 and 5.16 the location line reads "Your location was not found"
because the headless browser has no location; on a phone it reads "Inside the
job area" or "N m outside the job area".

## Map figures to capture by hand

Two existing figures show the job-area map: **5.12** and **usability-05**. A
third is offered for the report, since the map picker is the pass's main new
control. Take each in an ordinary browser (Chrome, zoom 100%, device scale 1),
where tiles and search load normally. A full-page capture keeps the same
framing as the scripted figures (Chrome DevTools: Ctrl+Shift+P, "Capture full
size screenshot").

| File to send | Screen | URL | Viewport | State |
|---|---|---|---|---|
| `figure-5-12-validation-empty-job-form.png` | Post a job, empty form submitted | `/client/jobs/new`, signed in as `client2@ledgerfield.test` | 1360 x 900, full page | Leave every field as loaded (deadline and defaults as given), place no pin, press **Publish the job** once. The red "Some fields are missing or invalid." banner and the field errors show, including "Choose the centre of the job area..." under the map (added by the defect 19 fix: take this on a build that has it; the scripted capture here predates it). Do not scroll the map. |
| `usability-05-post-job-form.png` | Post a job, as loaded | `/client/jobs/new`, signed in as `client2@ledgerfield.test` | 1360 x 900, full page | Nothing entered; map at its opening view (Nairobi). |
| `figure-5-17-job-area-map-picker.png` (new, optional) | Post a job, "3. Job area" group with a pin | `/client/jobs/new`, signed in as `client2@ledgerfield.test` | 1360 x 900; capture the "3. Job area" group only | Type `Kibuye Market, Kisumu` in "Find the place on the map", press Enter once, choose the first result, set the radius slider to **1 km**, open "Advanced: the values sent". Shows the pin, the circle, the attribution, and the three values the form sends. |

On the hosted app the only data these screens show is client2's "Available
now" balance in the commission summary, which differs from the seeded value
in the scripted figures; on a local copy started from a fresh seed
(`npm run db:seed`, then `npm start`) it matches them.
