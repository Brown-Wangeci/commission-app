# Screenshot captions

Captured 2026-11-16 with Playwright (`app/scripts/capture-screenshots.ts`,
committed) against the app, built and started against a freshly seeded
scratch database (`ledgerfield_ch5`), after the usability pass (branch
`usability-pass`). All 16 figures keep their file names and come from one run
of the script; none was skipped. Six further captures of screens the pass
changed are in `usability/`. Every caption below describes what the screenshot
actually shows, reviewed by hand after capture; nothing is staged beyond what
the seed script (`prisma/seed.ts`) and the capture script's own steps produce.

What changed from the 2026-11-11 captures, and what did not. The Accrue
tokens and components are unchanged (palette, Geist and Geist Mono, square
status badges). The pass is grouping, hierarchy and a few controls: the
reviewer's navigation has a new **Jobs** entry in every admin figure; the
review screen (figures 03, 04, 05, 10) now opens on the concern, the photos,
the decision and the model's score with its top three reasons, with submitted
details, the map, the history and the audit record as sections that open on
click; the client home page (figures 06, 14) lists open jobs before the escrow
and puts funding in a section; the sign-up page (figure 11) has live password
rules, a confirm field and show/hide buttons; the post-a-job page (figure 12)
has four groups and a commission summary beside them. Scoring, money, the
state machine, payments and the audit log are unchanged. The seed's data
differs slightly from 2026-11-11 (the hosted-deployment work changed it), so
some references and dates differ; that is not caused by the pass.

## figure-5-01-agent-status-list.png

Agent "My activations" list for Mercy Achieng, 12 rows, newest first. The
screen is unchanged by the pass except for what every agent screen gets from
the shared top bar. Shows a decision reason for each state: held ("Checked and
on hold... until 19 Nov 2026 at 10:25"), awaiting evidence ("A reviewer needs
more evidence...") and ten approved rows ("Released automatically when the
hold closed: the hold-close check gave 0.1%, at or below its release cut-off of
26.7%"). Each payout shows its working in mono beneath the amount. In this seed
Mercy has no refused activation; the refused case belongs to Samuel (figure
10).

## figure-5-02-admin-review-queue.png

Admin review queue, "Waiting for a decision" tab, 5 submissions, with the new
Jobs entry in the navigation. Each row shows the score, the band cut-offs, and
the top factors moving the score. Includes the disputed case (LF-000049) and
the could-not-be-scored case (LF-000055), whose row reads "No score yet: the
model could not be reached at submission. Retries continue; any later score is
advice only." The page is unchanged apart from its wording and empty states
(not visible here, because the queue has rows).

## figure-5-03-admin-review-mockup-case.png

Admin review screen for LF-000052 (Grace Wanjiku, the documented T7-review
mockup case), in its new layout. Left column: "Check this first" (no proof of
activation was attached, +1.03), then the nine photos in their two groups, then
four closed sections: Submitted details, Where it happened, History (5 events)
and Audit record, each with a one-line hint of what is inside. Right column,
from the top: the decision (Approving pays 0712345678, KSh 300.00 with its
working, "Approve & pay" as the one filled button, "Ask for evidence" and
"Reject" as quiet text buttons), the model assessment (fraud probability 50.9%,
between the 26.7% and 66.7% cut-offs, the thin three-zone scale, the top three
reasons, "All 2 scores for this submission" as a closed list), and the agent's
record.

## figure-5-04-awaiting-evidence.png

Admin view of LF-000056 (Mercy Achieng), state "Awaiting evidence". Because the
history is now a closed section, a new "Waiting for the agent" block at the top
says who asked, when, and what: "Amina Otieno asked on 15 Nov 2026 at 10:30:
'Please send a clear photo of the customer's SIM pack showing the serial
number, and the signed registration form.'" The decision panel offers nothing:
"This submission is awaiting evidence; there is nothing to decide here."

## figure-5-05-could-not-be-scored.png

Admin view of LF-000055 (Faith Chebet), the seed's deliberately engineered
could-not-be-scored case. "Check this first" says the model could not score it
at submission because the scoring service could not be reached, with 2 failed
attempts and the next automatic retry time. The model assessment reads
"Unavailable" and "No score: the model could not be reached at submission, so
it was sent to a person instead of being released." The audit record, now a
closed section, holds the underlying reason. The other wording this pass
added, for a hold-close score that cannot be built because no first-week
activity was reported, does not occur in this seed, so no screenshot shows it;
it is covered by `app/tests/usability-db.test.ts`.

## figure-5-06-client-escrow-and-jobs.png

Client home for client2@ledgerfield.test, in its new order. A one-line "next
step" callout (a funding payment is waiting for M-Pesa), "Open jobs (2)" with
each job's agents (12 / 40, 7 / 40), outcomes, commission with its working,
locked, released and unspent amounts, then "Your escrow" (deposited,
committed, available) and the "Fund your escrow" section, open here because a
payment is pending, with the M-Pesa form and the three funding attempts
(failed, pending, confirmed with receipt SIM0000002).

## figure-5-07-client-job-detail.png

Detail page for one of the client's own jobs ("Wallet activations, Kibuye
Market"). Unchanged by the pass: the commission formula, the escrow
lock/release/unspent figures, the evidence field configuration (4 fields,
version 1) and the job's 12 activations with their outcomes and reasons,
including a held case and the awaiting-evidence case. (A client who has just
posted a job, or whose open job has no agent yet, sees one extra line saying a
reviewer assigns agents next; this job has agents.)

## figure-5-08-payouts-with-failure.png

Admin payouts page, "Needs attention" banner showing 1 payout that did not
complete, with its Daraja failure reason ("The balance is insufficient for the
transaction.") and a "Retry payout" button. The remaining rows are paid, each
with its M-Pesa receipt number. Unchanged by the pass.

## figure-5-09-audit-log-with-anchoring.png

Admin audit log, full chain view. Banner: "Anchoring is waiting: POLYGON_RPC_URL,
POLYGON_CHAIN_ID, POLYGON_ANCHOR_CONTRACT_ADDRESS, POLYGON_PRIVATE_KEY not set.
Events are still recorded and chained." This capture ran without a chain
configured (see `docs/chapter5/evidence/blockchain/README.md` for the separate
local-Anvil anchoring run cited for IR-04). Unchanged by the pass.

## figure-5-10-dispute-verification-result.png

Admin review screen for the disputed submission LF-000049 (Samuel Mutua), with
the Audit record section opened and "Verify against the blockchain" pressed
(the capture script now opens the section first). Result: "Partly verified:
Every hash recomputes and links, 11 of 11 event(s) could not be checked on
chain yet", with a per-event pass list and the event table. The decision panel
shows "Ask for evidence" greyed, because evidence cannot be requested during a
dispute. As before, no chain is configured in this run, so the hash chain
verifies but nothing is checked on chain.

## figure-5-11-validation-signup-duplicate-email.png

Sign-up form submitted (client business) with an email already in use
(client2@ledgerfield.test), and with a password that meets the rule (at least 8
characters, three of four classes): both live rules read "Met", the confirm
field reads "The passwords match", and
the real server-side error is shown: "An account with this email already
exists." (The seeded password `ledgerfield-demo` no longer meets the sign-up
rule, so the script uses a fake value that does; the seeded accounts still sign in.) Captured
from a fresh, unauthenticated browser context.

## figure-5-12-validation-empty-job-form.png

Client "Post a job" form submitted with the title, description, place, centre
and value empty. Shows the four groups, the banner "Some fields are missing or
invalid", the per-field message under the commission value, and the defaults
the pass added: deadline 30 days ahead, radius 700 m, rate 10%, 10 activations.
The "Commission summary" beside the form shows the client's available balance
and the publish button. The 2026-11-11 capture also showed an error for the
number of activations; it now has a default.

## figure-5-13-validation-not-found.png

A non-existent activation id requested from the admin review detail route.
Shows the app's generic not-found page: "That page does not exist, or you do
not have access to it." Unchanged.

## figure-5-14-validation-forbidden-role.png

Client session shown after its own request to `GET /api/admin/review` returned
HTTP 403 (confirmed in the capture log, not visible in the image since the API
call was made directly); the screenshot is the client's own `/client` page,
included to show what that session can see instead.

## figure-5-15-agent-submission-form.png / figure-5-16-agent-submission-form-mobile.png

As before, the script posts a job as client2@, assigns it to Mercy Achieng
through the real routes and accepts it through the real UI: signs in at
`/login` (the password field now has a show/hide button), presses "Accept job"
on the agent home page and opens the form; nothing is submitted. figure-5-15
is the form at 1360x900; figure-5-16 is the same form at 360 px wide. Every
control on the agent screens is at least 48 x 48 CSS px; the measurement was
repeated after the pass (`docs/chapter5/evidence/nfr12-touch-targets.json`,
2026-11-16: all controls on the four agent pages meet 48 x 48 and none scrolls
sideways; the refused-activation page is measured from Samuel's list because
Mercy has none in this seed).

## usability/ (six supplementary captures)

- `usability-01-admin-dashboard.png`: the reviewer dashboard. "Needs your
  attention" first (5 awaiting a decision, 1 could not be scored, 1 payout
  failed or unconfirmed, 0 jobs waiting for an agent, each with the button to
  act), then the notifications, then the state counts in three groups (In
  progress 6, Needs a person 5, Done 51), then tabs for Recent model scores,
  Recent reviewer decisions and Hold window (4).
- `usability-02-admin-jobs.png`: the new Jobs list, "Needing an agent (4)", one
  row per job with its agents, commission, deadline and an Assign button.
- `usability-03-review-sections-open.png`: LF-000052 with all four closed
  sections opened by the script.
- `usability-04-signup-password-rules.png`: sign-up with a short password
  typed ("abc123": both rules "Not yet", "2 so far" of the character classes),
  the first field shown with its Hide button, and a confirm field that does not
  match.
- `usability-05-post-job-form.png`: the post-a-job page before anything is
  typed: four groups, defaults, and the commission summary with the available
  balance.
- `usability-06-agent-home-360.png`: the agent home page at 360 px: one job
  ready to submit with its single filled button, a notification, and "How a job
  works" as a closed section.
