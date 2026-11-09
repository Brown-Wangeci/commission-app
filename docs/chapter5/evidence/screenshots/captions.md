# Screenshot captions

Captured 2026-11-09 with Playwright (`app/scripts/capture-screenshots.ts`,
committed) against the app, built and started against a freshly seeded
scratch database (`ledgerfield_ch5`). Every caption below describes what the
screenshot actually shows, reviewed by hand after capture; nothing is staged
beyond what the seed script (`prisma/seed.ts`) and the capture script's own
validation-trigger steps produce. One figure from the brief could not be
captured; see "Not captured" at the end.

## figure-5-01-agent-status-list.png

Agent "My activations" list for Mercy Achieng, 11 rows, newest first. Shows
a decision reason for each state: held ("Checked and on hold... until 12 Nov
2026 at 10:25"), awaiting evidence ("A reviewer needs more evidence..."),
approved ("Released automatically when the hold closed: the hold-close check
gave 0.1%, at or below its release cut-off of 26.7%"), and refused ("Refused
by a reviewer. Customer says they never signed up. You can contest this
once.").

## figure-5-02-admin-review-queue.png

Admin review queue, "Waiting for a decision" tab, 5 submissions. Each row
shows the score, the band cut-offs, and the top factors moving the score
("About this submission" / "About the agent"). Includes the disputed case
(LF-000049) and the could-not-be-scored case (LF-000055, "No score" /
"the model could not be reached at submission"). Note: the payout column's
long working text wraps one character per line for the LF-000049 row at this
viewport width (1360x900) -- a real rendering issue, not fixed here since
this task is collection and measurement only.

## figure-5-03-admin-review-mockup-case.png

Admin review screen for LF-000052 (Grace Wanjiku, the documented T7-review
mockup case). Shows the evidence photos, the "no proof of activation was
attached" flag, the full model-assessment panel (fraud probability 50.9%,
between the 26.7% auto-approve and 66.7% auto-reject cut-offs), the location
map with the GPS-vs-job-area comparison, the full decision history (T0
13.4% auto_release -> held -> T7 50.9% review -> in_review), and the audit
record with its per-event hash and "waiting for the next batch" anchor
status.

## figure-5-04-awaiting-evidence.png

Admin view of LF-000056 (Mercy Achieng), state "Awaiting evidence," reached
after a reviewer asked for more proof. Shows the specific request text sent
to the agent ("Please send a clear photo of the customer's SIM pack showing
the serial number, and the signed registration form") and that the decision
panel offers nothing to decide while evidence is pending.

## figure-5-05-could-not-be-scored.png

Admin view of LF-000055 (Faith Chebet), the seed's deliberately-engineered
could-not-be-scored case. The model assessment panel reads "Unavailable":
"No score: the model could not be reached at submission, so it was sent to a
person instead of being released." The audit record's "Scoring call failed"
entry gives the real underlying reason recorded by the app: "could not reach
the scoring service: bad port." Two failed scoring attempts are noted, with
the next automatic retry time.

## figure-5-06-client-escrow-and-jobs.png

Client escrow and jobs view for client2@ledgerfield.test. Shows the
deposited/committed/available escrow balance, three funding attempts in
different states (failed, pending, confirmed) with M-Pesa receipt
SIM0000002 on the confirmed one, and two jobs with their locked/released/
unspent commission breakdown and outcome counts.

## figure-5-07-client-job-detail.png

Detail page for one of the client's own jobs ("Wallet activations, Kibuye
Market"). Shows the commission formula, the escrow lock/release/unspent
figures, the evidence field configuration (4 fields, version 1), and the
job's 12 activations with their outcomes and reasons, including a held case
and the same awaiting-evidence case as figure-5-04.

## figure-5-08-payouts-with-failure.png

Admin payouts page, "Needs attention" banner showing 1 payout that did not
complete, with its real Daraja failure reason ("The balance is insufficient
for the transaction.") and a "Retry payout" button. The remaining 47 rows
are paid, each with its M-Pesa receipt number.

## figure-5-09-audit-log-with-anchoring.png

Admin audit log, full chain view. Banner reads "Anchoring is waiting:
POLYGON_RPC_URL, POLYGON_CHAIN_ID, ANCHOR_CONTRACT_ADDRESS,
POLYGON_PRIVATE_KEY not set. Events are still recorded and chained." 706
events chained, 0 anchored, all 706 waiting for the next batch -- this
screenshot was taken without a chain configured for this run (see
`docs/chapter5/evidence/blockchain/README.md` for the separate local-Anvil
anchoring run captured for Build 4 and cited for IR-04).

## figure-5-10-dispute-verification-result.png

Admin review screen for the disputed submission LF-000049 (Samuel Mutua),
after clicking "Verify against the blockchain." Result banner: "Partly
verified -- Every hash recomputes and links, 11 of 11 event(s) could not be
checked on chain yet," followed by a per-event pass list. This reflects the
same no-chain-configured state as figure-5-09: the hash chain itself verifies
correctly, but there is no confirmed anchor to check the root against in this
run.

## figure-5-11-validation-signup-duplicate-email.png

Signup form submitted (role: client business) with an email already in use
(client2@ledgerfield.test). Shows the real server-side validation error: "An
account with this email already exists." Captured from a fresh,
unauthenticated browser context (the signed-in contexts used elsewhere
redirect away from /signup).

## figure-5-12-validation-empty-job-form.png

Client "Post a job" form submitted with every field empty. Shows the real
validation banner ("Some fields are missing or invalid") and the per-field
messages ("Enter the value in shillings, with at most two decimal places,"
"Enter a whole number of activations").

## figure-5-13-validation-not-found.png

A non-existent activation id requested from the admin review detail route.
Shows the app's generic not-found page: "That page does not exist, or you do
not have access to it."

## figure-5-14-validation-forbidden-role.png

Client session shown after its own request to `GET /api/admin/review`
returned HTTP 403 (confirmed in the capture log, not visible in the image
itself since the API call was made directly rather than through the page);
the screenshot is the client's own `/client` page, included to show what
that session can see instead.

## figure-5-15-agent-submission-form.png / figure-5-16-agent-submission-form-mobile.png

Captured 2026-11-09, separately from the main capture run above. The fresh
seed has no unsubmitted accepted assignment (every seeded assignment is
either unaccepted or already submitted), so one assignment was created for
this capture (a job posted by client2@ and assigned to Mercy Achieng,
through the real `/api/client/jobs` and `/api/admin/jobs/{id}/assign`
routes) and then **accepted through the real UI**: signed in as
mercy@ledgerfield.test at `/login`, clicked "Accept job" on the agent home
page, and navigated to the resulting submission form -- nothing was
submitted. figure-5-15 is the form at 1360x900; figure-5-16 is the same
form at 360px width, showing it reflows to one column without clipping
(the top nav's "My activations" label truncates to "M..." at this width,
a minor cosmetic detail, not a functional defect). Both show the form built
entirely from the job's evidence field configuration (version 1: ID
document, market stall number, stall photo) plus the platform's own fields,
and the real "Your location is not available" state (no geolocation in a
headless browser).
