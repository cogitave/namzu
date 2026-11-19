---
'@namzu/cli': patch
---

The terminal app names hypermode once. While the mode is on, the composer's upper right says `hypermode`; the status line used to repeat it as `effort high · hypermode` and now says only `effort high` (or nothing at the model default). The effort item still opens the picker when clicked.

`←` on an empty message box now opens the workspaces screen in the full screen view too, the default, where it used to open the workflow view instead because the screen was not available there. Where the workspaces screen cannot open (Windows, a non-interactive terminal), `←` never opens the workflow view: while a reply is running the first press says "Press ← again to open agents" and the second moves into the task rows under the status line. To turn that gesture off, set `tui.leftArrowOpensAgents: false` (Settings > Terminal, "Left arrow opens agents").

The task rows under the status line now read `❯ ◯ name  ▰▰▱▱  3/7 · 2m14s · ↓ 48.2k tokens`: a pointer column in front of the glyph, so every row starts two cells further in, and a key line of `↑↓ select · enter view · x stop`. `→` and `←` move between the tasks and the workflows, and in the full screen view each row is a click target that opens what Enter does. Enter on `main` from the conversation now opens the overview of its agents (`←` no longer does). The workflow detail is drawn above the message box instead of replacing it: the status line and the box stay on screen, and it takes half the terminal's height in the full screen view (`max(12, rows - 9)` otherwise). Inside it `j`/`k` move, `→` goes deeper, `←` goes back and closes at the top, and Space closes it.
