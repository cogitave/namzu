---
'@namzu/cli': minor
---

The workflow review and its progress row now use the screen they are on.

The review body is as tall as the terminal allows (the rows left after the frame, the question, the choices, the key line and the line above it, never fewer than 6) instead of a fixed 12, so at 30 rows you see about 16 rows of the name, purpose, phases, limits and the start of the script. On a terminal too short for that, the first screen holds the name, the purpose, the phase titles on one line and the limits line; the phase details and the "Shown as" line come after them, a page down, and nothing is left out. While the review is open the call row above it now reads `Workflow(<what it is for>)`, as it does after approval, not the raw call. At a narrow width the key line drops `↑↓ select` first, then `ctrl+c stop`, then `y / n`, then `esc cancel` (Escape still cancels), then `d script`, which is the only way to read the whole script; `enter confirm` stays longest.

The progress row narrows in a fixed order: the bar goes from 20 cells to 12, 8 and 4, then the token count goes, then `Large workflow`, then the name is cut with `…`. The `done/asked` count and the elapsed time stay for as long as any of the bar does, so they no longer disappear at 60 columns. With room to spare the row also names the phases that have an agent running (up to two titles, then `+N more`).

A run that asks for more agents than the session's size guideline (the configured `workflow.sizeGuideline`, else the default, `medium`, which is 10) is marked `Large workflow` on its row and the conversation gets one quiet line saying so and how to stop it (press ↓ then `x`, or `/workflows`). Nothing is stopped for you. This means the mark now appears above 10 agents with the default guideline, where it used to appear above 25; set `workflow.sizeGuideline: large` or `unrestricted`, or `NAMZU_WORKFLOW_SIZE_WARNING_AGENTS`, to move it. The row no longer carries `· /workflows to stop`.

Typing now works from the progress row: a `/` or any printable character leaves the row and goes to the input box, so you can enter a command without pressing Esc first. The arrows, Enter, `x` and Esc still belong to the row. The workflow detail screen no longer draws every kept `log()` line on a terminal shorter than 24 rows; it draws none there, one from 24 rows and three from 30.
