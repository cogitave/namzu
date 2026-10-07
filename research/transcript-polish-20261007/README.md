# Transcript polish proof (2026-10-07)

Per-reply edit cards, "Worked for" on finished turns, attachment cards above the bubble and
date separators, driven in the live preview (`/preview`, sample thread "Refine navigation").
Re-run `node research/transcript-polish-20261007/capture.mjs` with the desktop dev server up;
it prints PASS/FAIL lines and rewrites `artifacts/`. The browser runs in UTC with `en-GB`.

Fixture: three saved turns on two days (Mon 5 Oct 10:06; Tue 6 Oct 09:30 and 17:20). Turn one
edited one file, turn two three files, turn three nothing. Images: one loaded, one with no preview
(evicted), one pending attachment-only message.

| File | Shows |
| --- | --- |
| `00-top-dark-wide.png` | first separator, compact file cards on their own right-aligned row above the thumbnail card, "Preview unavailable" kept |
| `01-bottom-dark-wide.png` | loaded thumbnail above its bubble, pending spinner box with no bubble |
| `02-multi-expanded-dark-wide.png` | one-file card, "Edited 3 files" expanded with per-file totals, new-day separator |
| `03-filtered-drawer-dark-wide.png` | a file row opened one diff; "Showing selected changes · Show all" |
| `04-all-drawer-dark-wide.png` | after Show all: every receipt again |
| `04b`, `05` to `08` (light, 430px) | the same at phone width; no horizontal page scroll |

Checks (all PASS): three separators (first, new day, gap over 6 h); two edit cards; one
attachment-only message with no `.message-text`; the pending box and a loaded thumbnail are both
200 x 200, so resolving a preview moves nothing; filter line shown with one file change, gone after
Show all with all five receipts back.

Review-fix measurements (1440 dark / 640 light): the edit card is rgb(37,37,37) in dark (canvas about 24, so it reads as raised) and 250 in light; file chips and thumbnails are separate rows with the same right edge (x=1272 at 1440, 614 at 640); date separators sit 40px below the previous card and 20px above the next bubble, 24px from the top for the first.
