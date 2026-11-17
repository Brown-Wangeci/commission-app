# Usability pass: browser checks

`ui-checks.json` is the output of `app/scripts/verify-usability.js` run on
2026-11-16 against the app on a freshly seeded scratch database. It records
what the unit tests cannot: the show/hide control changes the input type and
a seeded account still signs in; the live password rules count met rules as
the password changes and a mismatch is reported; the review screen has exactly
one primary button, four sections closed at the start, a closed section opens
when the address points at it, and choosing Approve replaces the three
decision buttons with the reason form (still one primary button); and the
post-a-job commission summary is still on screen after scrolling to the bottom
of the form. The touch-target measurement is `../nfr12-touch-targets.json`.
