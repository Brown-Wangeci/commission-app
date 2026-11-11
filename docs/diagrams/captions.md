# Chapter 4 diagram captions

All diagrams and wireframes are traced from the committed code on `main`
(after PR #74), not from memory or from the design handoff bundle in
`design/`. Every arrow in the sequence diagrams is numbered on the diagram
and cited below by file and function. SVGs are hand-generated
(`seqgen.py`/`wireframe_kit.py`, not committed -- scratch tooling for this
PR only) and rendered to PNG at 2x with Playwright for the render check;
nothing here was drawn in a GUI tool.

**Revision (`chapter4-diagram-fix`):** the two sequence diagrams were
regenerated from the same traced flow, same arrows, same citations. No
title text is drawn inside any of the three images below (the figure
number lives in the write-up/caption, not the image). Every in-diagram
cross-reference that said "Figure 4.1a" now says "Figure 4.3", and every
one that said "Figure 4.1b" now says "Figure 4.4" (with "(b1)"/"(b2)"
added where the step being pointed to is specifically in one of the two
new files, so the reference stays unambiguous across a 2-file split).
Message numbers are unchanged from the previous revision. Part B is now
two files -- `sequence-diagram-b1-payout-and-anchoring` (messages 1-19)
and `sequence-diagram-b2-admin-decision-and-contest` (messages 20-28) --
each with its own trimmed lifeline header (no lifeline that never appears
in that file's messages) and a rendered width at or under 1800px at 2x.
Every message/self-call/note label is now >=15px at 1x (up from ~11.5-12px).

**Numbering collision, not resolved here:** Figures 4.2-4.7 below (the
wireframes, regenerated in `accrue-restyle`) already use 4.3 and 4.4
for the agent evidence form and the admin review item. Renaming the
sequence diagrams to 4.3 and 4.4 as instructed makes two different figures
share each of those numbers. This is flagged, not silently fixed, because
resolving it means renumbering one set or the other across the whole
write-up, which this PR's instructions did not ask for.

## Figure 4.3 -- Submission to decision

`sequence-diagram-a-submission-to-decision.svg` / `.png`. Lifelines: Agent
(PWA/browser), Next.js app, PostgreSQL (incl. triggers), FastAPI scoring
service, T7 scheduler/job table.

| # | What it shows | File : function |
|---|---|---|
| 1 | Agent accepts the assigned job | `app/src/app/api/agent/assignments/[id]/accept/route.ts` (POST) |
| 2 | Accept recorded in a transaction, with an audit event | `app/src/lib/escrow/holds.ts::acceptAssignment` |
| 3 | Acceptance confirmed to the agent | same route, return |
| 4 | Agent asks for the capture form | `app/src/app/api/agent/assignments/[id]/evidence-form/route.ts` (GET) |
| 5 | The job's current evidence configuration is read | `app/src/lib/evidence/config.ts::currentEvidenceConfig` |
| 6 | Platform + job fields, `evidenceConfigId`/version returned | same route, return |
| 7 | Agent submits evidence (multipart) | `app/src/app/api/agent/activations/route.ts` (POST) |
| 8 | Refuses if the client changed the fields since the form was opened | `app/src/lib/activations/submit.ts::configInForce` |
| 9 | Validates every platform + job field in one pass | `app/src/lib/activations/submit.ts::validateSubmission` |
| 10 | Activation + evidence rows created, T0 scoring enqueued, audited, in one transaction | `app/src/lib/activations/submit.ts::recordSubmission` |
| 11 | Builds the real request payload (recent activations, agent history) | `app/src/lib/scoring/payload.ts::buildScoreRequest` |
| 12 | Calls the scoring service | `app/src/lib/scoring/client.ts::callScoringWithRetry` |
| 13 | (alt: responds) Scoring service's reply | `src/serve/app.py` `/score` (Python) |
| 14 | Attempt logged, decision recorded | `app/src/lib/scoring/runner.ts::onSuccess`; `app/src/lib/scoring/decisions.ts::recordDecision` |
| 15 | (alt: timeout) No response within the configured timeout/retries | `app/src/lib/scoring/client.ts::callScoringWithRetry` (failure path) |
| 16 | Routed to a reviewer, never auto-released; audited | `app/src/lib/scoring/runner.ts::onFailure` / `routeUnscoredToReview` |
| 17 | (alt: T0 reject) Escalated to a reviewer at once -- not refused automatically | `app/src/lib/activations/outcomes.ts::applyT0Decision` |
| 18 | (alt: auto_release/review) Held for the hold window; T7 job enqueued | `app/src/lib/activations/outcomes.ts::applyT0Decision` |
| 19 | Submission result returned to the agent | `app/src/app/api/agent/activations/route.ts`, return |
| 20 | Scheduler finds due T7 jobs | `app/src/lib/scoring/jobs.ts::dueJobIds` |
| 21 | Claims the job (lease, safe under concurrent workers) | `app/src/lib/scoring/jobs.ts::claimJob` |
| 22 | Builds the T7 request, including first-week customer activity | `app/src/lib/scoring/payload.ts::buildScoreRequest` |
| 23 | Calls the scoring service (T7) | `app/src/lib/scoring/client.ts::callScoringWithRetry` |
| 24 | Scoring service's T7 reply | `src/serve/app.py` `/score` |
| 25 | Decision recorded and applied | `app/src/lib/scoring/decisions.ts::recordDecision`; `app/src/lib/activations/outcomes.ts::applyT7Decision` |
| 26 | (alt: auto_release) Approved | `app/src/lib/activations/outcomes.ts::applyT7Decision` |
| 27 | (alt: review) Sent to a reviewer | same |
| 28 | (alt: reject) Refused automatically; dispute opened | `app/src/lib/activations/outcomes.ts::applyT7Decision`; `app/src/lib/disputes/disputes.ts::openDispute` |

**Simplification:** the T0-reject and T7-band alternatives are drawn as
`alt` blocks even though they are really three separate code paths inside
one function (`applyT0Decision`/`applyT7Decision`); this keeps the diagram
to the shape of a single decision rather than three unrelated diagrams.

## Figure 4.4 (b1) -- Decision to payout and anchoring

`sequence-diagram-b1-payout-and-anchoring.svg` / `.png`. Messages 1-19 of
the old single "Figure 4.1b". Continues from Figure 4.3. Lifelines: Next.js
app, PostgreSQL, Scheduler (labelled "T7 scheduler/job table" in the
original brief; in the real code `scripts/scheduler.ts`'s one process tick
also runs the payments worker and the anchoring queue -- drawn as separate
lifelines per the brief, noted here rather than silently merged or split),
Daraja, Anchoring queue, AuditAnchor contract. (Agent and Admin are not
used by messages 1-19, so they are not drawn here -- see Figure 4.4 (b2).)

| # | What it shows | File : function |
|---|---|---|
| 1 | Commission recorded (whole-shilling rounding; remainder stays with the client) | `app/src/lib/payouts/authorise.ts::authorisePayout`; `app/src/lib/payouts/commissions.ts::recordCommission` |
| 2 | Payout authorisation + disbursement queued in the same transaction as the approval (never calls Daraja synchronously) | `app/src/lib/payouts/daraja.ts::DarajaPayoutAuthoriser.authorise`; `app/src/lib/payments/disbursement.ts::queueDisbursement` |
| 3 | Audited | `app/src/lib/payouts/authorise.ts::authorisePayout` |
| 4 | Scheduler's payments worker finds the queued disbursement | `app/src/lib/payments/worker.ts::runDuePayments`/`dueIds` |
| 5 | Claims it | `app/src/lib/payments/disbursement.ts::claimDisbursement` |
| 6 | Sends the B2C payment request | `app/src/lib/payments/disbursement.ts::sendDisbursement` (calls `b2cPayment`, `app/src/lib/payments/daraja-client.ts`) |
| 7 | Daraja accepts it | `app/src/lib/payments/disbursement.ts::recordAccepted` |
| 8 | Daraja delivers the result callback | `app/src/app/api/payments/callback/[kind]/[reference]/[signature]/route.ts` (POST) |
| 9 | Origin verified before the body is even read | `app/src/lib/payments/callback-origin.ts::originVerified` |
| 10 | Idempotent delivery registration (unique key, `ON CONFLICT DO UPDATE`) | `app/src/lib/payments/callbacks.ts::registerDelivery` |
| 11 | (alt: first delivery) Marked paid, receipt stored, audited | `app/src/lib/payments/callbacks.ts::applyPayoutSuccess`; `app/src/lib/payments/disbursement.ts::markPaid` |
| 12 | Agent notified | `app/src/lib/payments/disbursement.ts::markPaid` (calls `notify`) |
| 13 | Callback acknowledged | same route, return |
| -- | (alt: replay) Duplicate ignored, nothing re-applied | `app/src/lib/payments/callbacks.ts::registerDelivery` (note, not a numbered arrow) |
| -- | Escrow release is a derived read, not a write | `EscrowHoldState` view, `prisma/migrations/20261108090000_audit_chain_and_payout_hold/migration.sql` (note) |
| -- | Every audit insert is sealed at commit | `AuditEvent_chain` constraint trigger, same migration, `ledgerfield_audit_chain_seal()` (note) |
| 14 | Anchoring queue finds the next contiguous unanchored range | `app/src/lib/anchoring/queue.ts::createBatch` |
| 15 | Submits the Merkle root on chain | `app/src/lib/anchoring/chain.ts::submit` (viem `writeContract`); `contracts/AuditAnchor.sol::anchor` |
| 16 | Transaction hash returned | same |
| 17 | Waits for the receipt | `app/src/lib/anchoring/chain.ts::waitForReceipt` |
| 18 | Receipt confirms success | `AuditAnchor.sol`'s `Anchored` event |
| 19 | Batch confirmed, audited | `app/src/lib/anchoring/queue.ts::confirm` |

## Figure 4.4 (b2) -- Admin decision and contest

`sequence-diagram-b2-admin-decision-and-contest.svg` / `.png`. Messages
20-28 of the old single "Figure 4.1b". Lifelines: Agent (PWA/browser),
Admin (browser) (added -- not in the original brief's list of 8, but
"review (admin decision + reason)" cannot be shown without an actor for
it), Next.js app, PostgreSQL. (Scheduler, Daraja, Anchoring queue and
AuditAnchor contract are not used by messages 20-28, so they are not drawn
here -- see Figure 4.4 (b1).)

| # | What it shows | File : function |
|---|---|---|
| 20 | Admin approves or refuses a reviewed item, with a reason | `app/src/app/api/admin/review/[id]/approve/route.ts`, `refuse/route.ts` |
| 21 | Only `in_review`/`disputed` items can be decided | `app/src/lib/review/actions.ts::requireState` |
| 22 | Transition + review-item close + dispute effect, in one transaction | `app/src/lib/review/actions.ts::decide` |
| 23 | (alt: refused from in_review) A fresh refusal always opens a dispute | `app/src/lib/disputes/disputes.ts::openDispute` |
| 24 | (alt: refused from disputed) Resolves the contest | `app/src/lib/disputes/disputes.ts::resolveDispute` |
| 25 | Agent notified of the decision and reason | `app/src/lib/review/actions.ts::decide` |
| 26 | Result returned to the admin | approve/refuse route, return |
| 27 | Agent contests a refusal | `app/src/app/api/agent/activations/[id]/contest/route.ts` (POST) |
| 28 | Refused -> disputed, back to the admin queue, allowed once | `app/src/lib/disputes/disputes.ts::contestRefusal` |

**Simplification:** "Entry B1" (auto-release) is shown once, in Figure 4.4
(b1); in the real code the same `authorisePayout()` call happens whether
the T7 band was `auto_release` or an admin approved a reviewed item here in
(b2) -- the diagram notes this with "continues at Figure 4.4 (b1), entry
B1" rather than drawing the commission/B2C chain a second time in this file.

## Wireframes 4.2-4.7 (revision `accrue-restyle`)

The six wireframes were regenerated on 2026-11-11 from the restyled
components (branch `accrue-restyle`, Accrue design system): same six
screens, same file names, still low-fidelity greyscale. They now show the
Accrue structure -- white cards on a light page, uppercase mono eyebrow
labels, mono money right-aligned to the cent with its working beneath,
square mono status badges with a glyph, and a 3px left rule (no fill) for
the one thing that needs attention. Every size label in square brackets is
a measured value, not an estimate: agent screens from
`docs/chapter5/evidence/nfr12-touch-targets.json` (Playwright, 360x800,
`app/scripts/measure-touch-targets.ts`), admin and client screens from
Playwright bounding boxes at 1360x900 on the same build. NFR-12 (48 x 48
px) applies to the agent app only; admin and client screens keep Accrue's
native 36px buttons (30px for small ones), and the labels say so rather
than marking them as failures.

## Figure 4.2 -- Agent job list and assignment

`figure-4-02-agent-job-list.svg` / `.png`, drawn at 360px. Traced from
`app/src/app/agent/page.tsx` (`AgentHomePage`, `JobLine`),
`app/src/app/agent/layout.tsx` and `app/src/components/ActionButton.tsx`.
Shows the two-row top bar used at phone width, the notifications card,
and the "waiting to accept" and "ready to submit" sections. Measured:
"Accept job" 109.5 x 48, "Submit activation" (a link) 156.6 x 48, "Mark
all read" 125.6 x 48, nav links and "Sign out" 48 tall; 10 of 10 controls
at least 48 x 48, no sideways scroll.

## Figure 4.3 -- Agent evidence form, 360px width

`figure-4-03-agent-evidence-form-360px.svg` / `.png`. Traced from
`app/src/components/agent/SubmitActivationForm.tsx` and
`EvidenceFieldInputs.tsx`, at the 360px width NFR-12 specifies. Every
field shown (customer phone, SIM date, capture method, proof, note, then
the job's own configured fields, then the device-captured location) is a
real field in those components; controls are drawn at their measured
height. Measured: text, date and file inputs 260 x 48, the note textarea
260 x 96, each radio a 48 x 48 target (dashed outline on the figure), "Use
my current location" 199.8 x 48, the device-details summary 294 x 48 (its
two selects 294 x 48 and demo button 294 x 60 when opened), "Submit
activation" 156.6 x 48; 25 of 25 controls at least 48 x 48 with the device
details opened, no sideways scroll.

## Figure 4.4 -- Admin review item

`figure-4-04-admin-review-item.svg` / `.png`. Traced from
`app/src/components/review/ReviewHeader.tsx`, `EvidenceStrip.tsx`,
`ConcernCallout.tsx`, `SubmittedDetails.tsx`, `LocationPlot.tsx`,
`ModelAssessment.tsx`, `ReasonList.tsx`, `RiskScale.tsx` and
`PayoutPanel.tsx`. Values are the seeded LF-000052 case (50.9%, factors
+1.03 / -1.01 / +0.95, cut-offs 26.7% and 66.7%). `AgentCard.tsx` (agent
history) is left out to keep the figure to one page. The decision buttons
("Approve & pay", "Ask for evidence", "Reject") each measure 330 x 36 at
1360px; the queue rows' own Approve and Reject buttons measure 76.6 x 30
and 65.1 x 30.

## Figure 4.5 -- Client job creation with evidence-field editor

`figure-4-05-client-job-creation.svg` / `.png`. Traced from
`app/src/components/client/PostJobForm.tsx` and
`EvidenceFieldsEditor.tsx`. The six "+ Text / + Number / + Date / + Choice
from a list / + Phone number / + Photo" buttons are the real field-type
picker. Measured at 1360px: "Publish the job" 131.2 x 36, "+ Text" 62.2 x
30, "Use my current location as the centre" 252.7 x 30.

## Figure 4.6 -- Client escrow and funding

`figure-4-06-client-escrow-funding.svg` / `.png`. Traced from
`app/src/components/client/FundForm.tsx` and `FundingList.tsx`, and the
deposited/committed/available stat cards and per-job lock/release/unspent
row from `app/src/app/client/page.tsx`. The three funding-history statuses
shown (failed, pending, confirmed) are the real `FundingAttempt.status`
values this component renders. Measured at 1360px: "Pay with M-Pesa" 143.8
x 36, "Post a job" (a link) 88.9 x 56.

## Figure 4.7 -- Audit trail panel with verify result

`figure-4-07-audit-trail-panel.svg` / `.png`. Traced from
`app/src/components/audit/AuditTrailPanel.tsx`, including its
`AnchorCell` (on-chain status per event) and `CheckLine` (per-event
verification result) sub-components. The "Partly verified" result and
"10 of 10 event(s) could not be checked on chain yet" wording match
`docs/chapter5/evidence/screenshots/figure-5-10-dispute-verification-result.png`
(recaptured 2026-11-11 after the restyle, same component, same
unconfigured-chain state). "Verify against the blockchain" measures 224.1
x 36 at 1360px.

## Combined sheet

`wireframes.svg` / `.png` lays out figures 4.2-4.7 together on one sheet,
for a single-image reference; the six `figure-4-0N-*.svg`/`.png` files
are the per-screen originals meant for individual placement in the write-up.

## On "one A4 page"

Even split into three files (4.3, 4.4(b1), 4.4(b2)), each is taller than
one A4 page at a font size that stays legible, now more so than the
previous revision since every label grew to >=15px at 1x -- the traced
flow is still 28 real arrows across the three files with several `alt`
branches, and shortening further would mean dropping steps, not
simplifying their presentation. All three are built to be placed as a
single tall image spanning two or more pages in the write-up, or printed
landscape at reduced text size; this is disclosed rather than solved by
omitting steps the code actually takes. 4.4(b1) and 4.4(b2) are each at
or under 1800px wide at 2x, as specified.
