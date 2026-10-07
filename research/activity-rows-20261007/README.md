# Activity rows (Desktop)

Proof for [Action rows](../../docs/cli/desktop.md#action-rows): the transcript's work list drawn as
one-line rows like the reference (images 17 to 19), instead of the inline Before/After block (16).

Captured from the live dev preview with Playwright Chromium. Saved turns: `/preview?activity=1`.
Running turn: `/preview?live=1` (`&hold=edit` stops it while the edit is under way). Light theme is
`localStorage['namzu.appearance'] = 'light'` before load.

| File | Shows |
| --- | --- |
| `01-saved-closed-dark.png` | restored history opens closed: "Worked for 42s" with the answer |
| `02-finished-open-dark.png` | two turns opened: "Ran 2 commands, edited a file" over Ran command, Ran command, Created empty.txt (the finished turn of image 19); the second turn's six actions folded to one summary row |
| `03-tooltip-path-dark.png` | hover on the file name shows the full absolute path (relative paths resolve against the project) |
| `04-click-changes-dark.png` | click on "Created empty.txt" opens the Changes panel on that file for that reply |
| `05-live-command-dark.png` | live: "Working for 2s", no chevron, narration, "Running command" |
| `06-live-editing-dark.png` | live: "Working for 9s"; "Running a command, reading a file, editing a file" over Ran command, Read notes.md, Editing app.css |
| `07-light-finished.png`, `08-light-live.png`, `13-light-collapsed-run-opened.png` | the same in the light theme at 900x720 |
| `09-collapsed-then-opened-dark.png` | the six-action run opened by hand: Read, Searched, Ran command, Edited, Created, Ran command |
| `10-command-tooltip-dark.png` | hover on "Ran command" shows the command; chevron appears on hover |
| `11-keyboard-focus-tooltip-dark.png`, `12-keyboard-enter-opens-changes-dark.png` | keyboard: focus on the row shows the path tooltip and an inset focus ring; Enter opens the Changes panel |

The shimmer was checked by reading the computed style of the live row twice: `animation-name:
working-shine`, text transparent, `background-position` moving between reads.

`14-live-finished-stays-open-dark.png`: the live turn after it ended; the heading says "Worked for 0s"
because the preview's scripted events carry no clock, and the list stays open as it was while live.

## Adversarial review

`15-review-live-only-running-shimmers-dark.png`: the live run; only "Reading notes.md" and the
summary shimmer, the finished "Ran command" row inside the run no longer does (it did, because the
run's `.active` class matched every label under it). `16-review-light-tooltip.png` and
`17-review-dark-open.png`: light tooltip and dark finished turns after the fixes.

## Second pass

`18-pass2-*`: before and after of the finished turn, dark 1440x900 and light 900x720, cropped to the
transcript column, plus the live turn after. Differences against 17/18/19 fixed: rows and narration
were indented 28px with a left rail (now flush with the heading); finished rows were the same muted
colour as the running row (now a step lighter, summary line stays muted); the list had 16px above it,
and 8px below it (now 12px above, 0 below).
