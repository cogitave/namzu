---
'@namzu/cli': patch
---

The terminal app names hypermode once. While the mode is on, the composer's upper right says `hypermode`; the status line used to repeat it as `effort high · hypermode` and now says only `effort high` (or nothing at the model default). The effort item still opens the picker when clicked.

`←` on an empty message box now opens the workspaces screen in the full screen view too, the default, where it used to open the workflow view instead because the screen was not available there. Where the workspaces screen cannot open (Windows, a non-interactive terminal), `←` never opens the workflow view: while a reply is running the first press says "Press ← again to open agents" and the second moves into the task rows under the status line. To turn that gesture off, set `tui.leftArrowOpensAgents: false` (Settings > Terminal, "Left arrow opens agents").
