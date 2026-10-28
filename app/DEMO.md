# Ledgerfield demonstration path

A click-through from job posting to final decision. It includes one
activation whose band changes between the submission-time (T0) and
hold-close (T7) scores, and one that goes through "awaiting evidence". It
runs on seed data from a clean checkout with no manual database edits.

Every probability, band, cut-off and reason you will see comes from the
scoring service. The seeded cases were scored by the real models when the
seed ran. The live submission in Part 2 is scored live, so its exact numbers
depend on the day you run it (see "What to expect" in Part 2).

## Before you start

You need four things running. App setup is in [README.md](README.md).

| Terminal | From | Command |
|---|---|---|
| 1. Database | `app/` | `npm run db:start` |
| 2. Scoring service | repository root | `.venv\Scripts\python.exe -m uvicorn src.serve.app:app --host 127.0.0.1 --port 8000` |
| 3. App | `app/` | `npm run build` then `npm start` (or `npm run dev`) |
| 4. Seed (once per demo) | `app/` | `npm run db:seed` |

The seed takes about half a minute and needs the scoring service, because it
never writes a score by hand. It ends with a table of named cases and
"Every named case landed where intended." Rerun it any time to reset the demo.

Do not start the scheduler (`npm run scheduler`) before Part 1. One seeded
case ("could not be scored") is waiting for an automatic retry, and the
scheduler would score it.

Open http://localhost:3000. Every account's password is `ledgerfield-demo`.

| Who | Email | Role |
|---|---|---|
| Amina Otieno | `reviewer@ledgerfield.test` | admin (reviewer) |
| David Mwangi | `reviewer2@ledgerfield.test` | admin |
| Joyce Njeri, Mwanga Mobile | `client@ledgerfield.test` | client |
| Peter Ochieng, Tujenge Pesa | `client2@ledgerfield.test` | client |
| Grace Wanjiku | `grace@ledgerfield.test` | agent, 550 days, clean record |
| Mercy Achieng | `mercy@ledgerfield.test` | agent, 400 days, Kisumu |
| Samuel Mutua | `samuel@ledgerfield.test` | agent, refusals and a dispute |
| Faith Chebet, Kevin Omondi, Brian Kiprop | `faith@`, `kevin@`, `brian@` | agents |

Use two browser windows (or one normal and one private) so you can stay
signed in as the reviewer while switching between the client and the agent.

## Part 1: the review screen (seed data, about 5 minutes)

Sign in as **reviewer@**. The top bar shows the review queue count.

1. **Review queue.** Five submissions wait for a decision, oldest first.
   Point out:
   - the "About this submission" and "About the agent" columns: factors
     about the person are kept apart from factors about the job;
   - **LF-000055** (Faith): "Could not be scored (T0)", no score, two failed
     calls. The scoring service was unreachable for that submission, so it
     came to a person instead of being released.
2. Click **Start reviewing**. This opens **LF-000050**, Grace Wanjiku at
   Gikomba Market, the case modelled on the design.
   - **What the agent submitted:** eight numbered photos with a "+3" tile.
     The caption flags photo 6, taken outside the job area, and no proof of
     activation.
   - **Check this first:** the model's biggest concern is the missing proof
     (+1.04), with its own checks (view the photos, ask the agent).
   - **Submitted details:** the network reported Mombasa while the GPS fix is
     in Nairobi. The previous submission was 22 minutes earlier and 9.3 km
     away. Click **map**: the dashed line runs from Thika Road Mall to
     Gikomba.
   - **Agent card:** 100% approval, 20 approved, 0 rejected. **View full
     history** opens her record.
   - **Model assessment:** 38.2% from the hold-close model, "between the
     auto-approve cut-off (26.7%) and the auto-reject cut-off (66.7%), so it
     was sent to a person". In "What moved the score", "The agent has been on
     the platform 531 days" (-1.01) is tagged **About the agent** and tinted:
     the reviewer can see when they are being told about the person rather
     than the job. Open "All 2 scores": at submission this was 10.5%,
     auto-release, with the submission-time model's own cut-offs (30.1% /
     72.9%).
   - **Payout panel and closing line:** approving pays her payout number,
     KSh 300 from the job's escrow hold. The model advises; the person decides.
3. Click **Next** to see the other variants of "why it is here":
   - **LF-000052** (Brian, 15 days on the platform): rejected at submission
     (74.7%) but escalated rather than refused, because a submission-time
     score never refuses on its own. Its biggest concern is about the agent
     (his short tenure), and the callout says so.
   - **LF-000047** (Samuel): refused automatically at hold-close (75.7%), then
     contested by the agent; "Ask for evidence" is disabled during a dispute.

**The band-change case on seed data:** on the Agents page, open Mercy
Achieng and then **LF-000048**. It was "review" at submission (49.4%), held,
then released automatically at hold-close (0.1%) once the customer's first
week showed steady use. The History section lists both steps.

## Part 2: from job posting to final decision (live, about 8 minutes)

This creates a new activation whose band changes between T0 and T7.

1. **Client posts and funds a job.** Sign in as **client2@** (Tujenge Pesa).
   **Post a job**: title "Wallet activations, Kibuye Market (demo)";
   description "Sign up new wallet customers at the market."; place "Kibuye
   Market, Kisumu"; centre `-0.0995`, `34.768`; radius `800`; payout `350`;
   commission `10`; activations wanted `2`; deposit `700`. You land on the job
   page: KSh 700 funded, KSh 700 available.
2. **Platform assigns an agent.** As **reviewer@**: **Clients**, then open the
   new job. Choose **Mercy Achieng (Kondele, Kisumu)** and **Assign**. KSh 350
   is now locked in an escrow hold ("reserved").
3. **Agent accepts and submits.** Sign in as **mercy@**. On **My jobs**,
   **Accept job**, then **Submit activation**:
   - customer phone: any new number, e.g. `0711 234 567`;
   - SIM registration date: yesterday; leave "Scanned the code" selected;
   - photos: two or three of any images (placeholders are fine);
   - leave proof of activation empty;
   - open **Simulated device details (demonstration only)**: set the region
     reported by the network to **Mombasa (region_c)**, then **Use the job
     area centre as my location (demo)**;
   - **Submit activation**.

   The page shows the status. It is usually **Checked and on hold**
   (submission-time band auto-release or review). As the reviewer, open the
   activation from the Dashboard's **Hold window** panel and note the T0
   probability and band.
4. **Client reports the customer's first week.** As **client2@**, open the
   job and click **Report activity** on the new activation.
   - If T0 was **auto-release**: leave every day inactive and untick "SIM
     active at day end" for days 4 to 7 (a customer who never used the
     wallet and lapsed).
   - If T0 was **review** or **reject**: tick "Customer active" every day and
     enter some transactions, top-ups and minutes.

   **Save first-week activity.** Either way the week pushes the hold-close
   band the other way from the submission-time band.
5. **Close the hold now.** As **reviewer@**, on the Dashboard click **Force T7
   now** beside the activation, or use **Score with the hold-close model
   now** on its review screen. A demo cannot wait seven days; this is the
   admin control for that. The T7 score is stored next to the T0 score.
6. **Final decision.**
   - If it is now **In review**, it is in the queue with the line "falls
     between the auto-approve cut-off and the auto-reject cut-off". Open it.
     "All 2 scores" shows the band change. **Approve & pay** with a reason.
   - If the hold-close model released or refused it automatically, that is
     the final decision; the History shows it, and a refusal carries a
     dispute record the agent can contest once.
7. **See the outcome everywhere.** **Payouts** lists the authorisation (KSh
   350 to Mercy's number, by Amina Otieno, via `noop`). As **client2@** the job
   shows the outcome and the reviewer's reason. As **mercy@**, **My
   activations** shows "Approved by a reviewer" with the reason. The **Audit
   log** shows every step.

**What to expect.** On the build rehearsal (28 October 2026) step 3 scored
auto-release at T0 (24.1%; cut-offs 30.1% / 72.9%), the dormant week in
step 4 gave review at T7 (50.9% to 54.1% across two runs; cut-offs 26.7% /
66.7%), and the reviewer approved. The model reads the time to the next
payout cutoff, so the T0 number can differ on another day. The branch in
step 4 keeps the band change either way.

## Part 3: awaiting evidence (about 3 minutes)

Use the seeded **LF-000050** (Grace), or the live activation if it is in review.

1. As **reviewer@**, open LF-000050 and click **Ask for evidence** (or "Ask the
   agent for evidence" in the "Check this first" box). Write what you need,
   e.g. "Send a photo of the activation confirmation SMS", and **Send the
   request**. The submission leaves the waiting list and appears under
   **Awaiting evidence from the agent**, with what was asked.
2. Sign in as **grace@**. A notification says a reviewer needs more evidence.
   Open the activation: the request is quoted with a reply form. Add a note
   and a photo and **Send to the reviewer**. The status returns to **With a
   reviewer**.
3. As **reviewer@**: the Dashboard notification says the agent responded,
   and the item is back in the waiting queue ("Evidence returned"). Its
   History shows the request, who asked, and the agent's reply. The new
   photo is numbered after the originals. **Approve & pay** with a reason.

Mercy's **LF-000056** is already parked in "awaiting evidence" if you want to
show the agent's side first.

## Optional extras

- **A scoring failure.** Stop the scoring service (Ctrl+C in terminal 2) and
  submit another activation as an agent (assign a second slot first). It
  goes to the queue as "Could not be scored (T0)", never released. Restart
  the service, then on the Dashboard click **Run due scoring now** once the
  retry is due (about a minute): the score is stored as advice and the flag
  clears, but the activation stays with the reviewer.
- **The scheduled path.** Set `HOLD_WINDOW_SECONDS=120` in `app/.env`, restart
  the app, and run `npm run scheduler` in another terminal. A new submission
  is held for two minutes, then scored at hold-close by the scheduler without
  anyone clicking. Stopping and restarting the scheduler loses nothing; it
  reads the schedule from the database.
- **A contested refusal.** Sign in as **samuel@**, open LF-000046 (refused
  automatically) and **Contest the refusal**. It returns to the queue as
  "Refusal contested".

## Rehearsing without clicking

`npm run demo:rehearse` (in `app/`, with the app, scoring service and seed
running) walks Parts 2 and 3 through the app's own HTTP API, signed in as
each role, and prints each step. On the build machine it printed:

```
== 3. Agent (mercy@) accepts and submits an activation; it is scored at T0
   LF-000063 submitted; state now held
   T0 auto_release at 24.1% (cut-offs 30.1% / 72.9%)
== 4. Client reports the customer's first week (never active, SIM off from day 4)
== 5. Reviewer forces the hold-close (T7) score instead of waiting seven days
   T7 run: scored; state now in_review
   T7 review at 54.1% (cut-offs 26.7% / 66.7%)
== 6. Reviewer opens the review screen and approves with a reason
   final state: approved; payout authorised: yes
   band changed between T0 and T7: yes
== 7. Awaiting evidence, on the seeded mockup-like case
   LF-000050: evidence requested -> awaiting_evidence
   Grace responded -> in_review
   reviewer approved -> approved; payout authorised: yes
```

Re-seed (`npm run db:seed`) before presenting, since the rehearsal changes the
seeded cases it touches.
