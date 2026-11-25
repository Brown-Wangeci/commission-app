# IR-10: colour contrast and target size audit, 25 November 2026

## Verdict

**Met, on the criteria below.** The after run on the hosted app found no
contrast failure and no target-size failure on any audited screen state, and
nothing was left undetermined or unaudited.

## What was applied

- **Contrast:** WCAG 2.1 AA, SC 1.4.3 (text 4.5:1, large text 3:1) and SC
  1.4.11 (field boundaries, focus rings and marks 3:1).
- **Target size:** WCAG 2.1 has **no target-size criterion at level AA**; its
  SC 2.5.5 (44 x 44 px) is level AAA. The audit applies axe's `target-size`
  rule, SC 2.5.8 of WCAG 2.2 (level AA): 24 x 24 px, or enough spacing. Many
  controls are under 44 x 44 px (table below): this record does **not** claim
  SC 2.5.5. The agent screens' 48 px targets are NFR-12.

## Runs

| Report | App | When | Code |
|---|---|---|---|
| `before.json` | hosted | 09:06:29 UTC (12:06:29 EAT) to 09:13:05 UTC (12:13:05 EAT) | production at `1f348f8`, before the fix |
| `after.json` | hosted | 09:15:54 UTC (12:15:54 EAT) to 09:23:39 UTC (12:23:39 EAT) | production at `db85d92` (PR #96), READY 09:15:10 UTC (12:15:10 EAT) |
| `local-agent-states.json` | local copy of `db85d92`'s fix, seeded | 09:16:23 UTC (12:16:23 EAT) to 09:16:56 UTC (12:16:56 EAT) | three agent activation states the hosted run did not reach |

chromium 156.0.8078.4, axe-core 4.14.1, widths 360 px (touch) and 1366 px.
Every browser request other than GET, HEAD and OPTIONS was set to be blocked;
neither hosted run made one.

## Totals

| | Before, 11 screens | After, 11 screens | Before, all screens | After, all screens |
|---|---|---|---|---|
| Screen states audited | 42 | 42 | 102 | 102 |
| Screens not audited | 0 | 0 | 0 | 0 |
| Text contrast failures found by axe | 46 | 0 | 106 | 0 |
| Text contrast failures found where axe could not judge | 4 | 0 | 4 | 0 |
| Text checks axe could not judge (worked out by the script) | 1005 | 1001 | 2591 | 2611 |
| Still undetermined | 0 | 0 | 0 | 0 |
| Placeholder text under 4.5:1 | 24 | 0 | 24 | 0 |
| Field boundaries under 3:1 | 170 | 0 | 330 | 0 |
| Targets failing the 24 px rule | 0 | 0 | 0 | 0 |
| Target checks axe could not judge | 0 | 0 | 0 | 0 |
| Controls measured | 1146 | 1146 | 2668 | 2692 |
| Controls under 44 x 44 px (information only) | 814 | 814 | 1982 | 1994 |

Counts are element findings summed over every screen, state and width, so one
element seen in two states counts twice.

## By screen (before → after)

Screens marked * were not in the audit brief and were added.

| Screen | Text | Placeholder | Field boundary | Target (24 px) | States |
|---|---|---|---|---|---|
| Sign in | 0 → 0 | 0 → 0 | 4 → 0 | 0 → 0 | 2 |
| Sign up | 0 → 0 | 8 → 0 | 42 → 0 | 0 → 0 | 6 |
| Agent job list | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 4 |
| Activation form | 0 → 0 | 4 → 0 | 32 → 0 | 0 → 0 | 4 |
| Client dashboard | 2 → 0 | 4 → 0 | 4 → 0 | 0 → 0 | 2 |
| Post a job | 0 → 0 | 0 → 0 | 56 → 0 | 0 → 0 | 4 |
| Escrow | 4 → 0 | 8 → 0 | 8 → 0 | 0 → 0 | 4 |
| Admin dashboard | 4 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 4 |
| Review queue | 36 → 0 | 0 → 0 | 24 → 0 | 0 → 0 | 4 |
| Review screen | 4 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 4 |
| Payouts | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 4 |
| Agent activations * | 16 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 4 |
| Agent activation detail * | 4 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 4 |
| Client job * | 4 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 4 |
| Client evidence fields * | 0 → 0 | 0 → 0 | 60 → 0 | 0 → 0 | 4 |
| Client activity report * | 0 → 0 | 0 → 0 | 96 → 0 | 0 → 0 | 4 |
| Client audit record * | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 4 |
| Queue: awaiting evidence * | 4 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 4 |
| Review evidence gallery * | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 4 |
| Admin jobs * | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 4 |
| Admin job * | 28 → 0 | 0 → 0 | 4 → 0 | 0 → 0 | 4 |
| Admin agents * | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 4 |
| Admin agent * | 4 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 4 |
| Admin clients * | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 4 |
| Admin audit log * | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 4 |
| Not found * | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 4 |

## Causes and fixes (design tokens in `app/src/app/globals.css`)

| Token | Before | After | Ratio before → after |
|---|---|---|---|
| `--status-pending` (amber text on its soft tint) | `#a15c07` | `#965506` | 4.44 → 5.00 |
| `--ink-4` (faint text and placeholders, on white) | `#8c887f` | `#6b6860` | 3.53 → 5.56 |
| `--line-control` (new: field boundary, on white) | `--line-2` `#d6d2c9` | `#86827a` | 1.51 → 3.83 |
| Field hover boundary | `--ink-5` | `--ink-3` | kept above the new resting boundary |

No screen or component sets a colour of its own. `app/tests/design-tokens.test.ts`
(TC-146, TC-147) holds the token pairs in CI, including hover and error colours
that a page scan does not render.

## Manual checks

Judged by reading the code and computing token ratios, not by a person using the
screens.

| Item | Finding |
|---|---|
| Risk scale on the review screen | Adjacent zones are 1.31:1 and 1.14:1, and the score marker is 2.31 to 3.01:1 on them. **Judged not a failure of SC 1.4.11:** the score and both cut-offs are written beside the scale as text, so the colours are not needed to read it. Each zone is at least 5.8:1 on the white card |
| Location plot | Markers and the job area use accent, ink and amber on the plot's background or the area's tint, all at least 5:1 |
| Button, chip and card borders | Remain `--line-2` (1.51:1). Each button and chip is identified by its text, so SC 1.4.11 does not require the border |
| Agent radios and checkboxes | Drawn with `--ink-3` (7.2:1) unchecked and `--accent` checked |
| Disabled controls | Exempt from both criteria |

## Remaining violations

None found on the criteria above.

## Not covered

- Hover, focus and error states were not rendered by the page audit; their
  colours are covered by the token test.
- The evidence-response, contest and withdraw forms were audited on the local
  copy only (`local-agent-states.json`), not on the hosted app.
- The application error pages (`error.tsx`, `global-error.tsx`) and browser
  confirmation dialogs.
- Chromium only, at two widths. No other browser, no real device, no zoom or
  text-spacing settings, no assistive technology and no user testing.
- Other WCAG criteria (keyboard use, names and labels and so on): outside IR-10.

## Hosted data written for this audit

One command, approved beforehand: at 09:06:15 UTC (12:06:15 EAT) client2@ posted
a one-slot job locking KSh 10.00, the seeded reviewer assigned it to Mercy and
Mercy accepted it (`hosted-verify.ts open-assignment`), because no seeded agent
had an unsubmitted job and the activation form could not otherwise be opened. It
was left unsubmitted. A first before run, made without it, was replaced.

## Reproducing

From `app/`:
`APP_URL=<origin> npx tsx scripts/audit-accessibility.ts <out.json> <label>`

## Re-run after the UI pass (PRs #100 to #103)

`ui-pass.json`: the same script on the hosted app at production `8d87718`
(Vercel production deploy READY 15:41:40 UTC, 18:41:40 EAT), from 15:42:21 UTC
(18:42:21 EAT) to 15:50:42 UTC (18:50:42 EAT). chromium 156.0.8078.4, axe-core
4.14.1, 360 px (touch) and 1366 px. No browser request other than GET, HEAD
and OPTIONS was made. The OpenStreetMap tile and search hosts were blocked
(their usage policies forbid automated clients), so the job-area map was
audited without tiles; its attribution sits on a solid surface in a checked
text token, so its contrast does not depend on the tiles.

| | Requested screens | All screens |
|---|---|---|
| Screen states audited | 42 | 102 |
| Screens not audited | 0 | 0 |
| Text contrast failures found by axe | 0 | 0 |
| Text contrast failures found where axe could not judge | 0 | 0 |
| Still undetermined | 0 | 0 |
| Placeholder text under 4.5:1 | 0 | 0 |
| Field boundaries under 3:1 | 0 | 0 |
| Targets failing the 24 px rule | 0 | 0 |
| Target checks axe could not judge | 0 | 0 |
| Controls measured | 1078 | 2490 |
| Controls under 44 x 44 px (information only) | 756 | 1808 |

**Still met:** 0 contrast and 0 target-size violations on every audited
screen state. A run on a local copy of PR #103 before it was merged found the
new radius slider with no field boundary (four findings, the post-a-job page
at both widths, as loaded and with an evidence field added); the slider was
given the field boundary token (commit `292a8be`, test TC-177) and a second
local run found nothing. The activation form was audited through the same
open assignment as before; nothing was written for this re-run.

The agent screens' 48 px targets (NFR-12) were measured again with
`app/scripts/measure-touch-targets.ts` on a local copy of `8d87718` started
from a fresh seed: every control on every agent page is at least 48 x 48 px and
no page scrolls sideways at 360 px
(`../nfr12-touch-targets-ui-pass.json`).

## Sign-up and Post a job after the sign-up location change (defect 19)

`signup-local.json`: the same script limited to the two screens the change
touches (`AUDIT_ONLY="Sign up,Post a job"`), on a local production build of the
branch, before merge. 14 screen states at 360 px and 1366 px, including sign-up
with a place chosen and "Advanced" open, and Post a job after "Publish the job"
with nothing entered: no text, placeholder, field-boundary or target-size
failure, nothing undetermined. The place search in the chosen-place state was
answered by a stand-in result in the browser; nothing was sent to
OpenStreetMap.

**Hosted run after deployment:** `signup.json`, the same two screens on
production `c231be8` (PR #105, tag v1.2.2; Vercel production deploy READY
18:14:17 UTC, 21:14:17 EAT), from 18:14:55 UTC (21:14:55 EAT) to 18:16:23 UTC
(21:16:23 EAT), chromium 156.0.8078.4, axe-core 4.14.1. 14 screen states, 347
controls measured: **0 contrast and 0 target-size failures**, nothing
undetermined and no screen state unaudited. No browser request other than GET,
HEAD and OPTIONS was made. The other screens were not re-audited; their record
is `ui-pass.json` above.
