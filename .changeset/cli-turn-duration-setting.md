---
'@namzu/cli': minor
---

New setting `tui.showTurnDuration` (default on) with `/config showTurnDuration on|off|list`: off leaves the `Worked for 24s · done 10:47 PM` line out after a reply, for live and restored conversations. A reply that delegated work still ends with its `N agents · tokens` line, without the duration.

Visible changes to know about: a message you send while a reply is running no longer shows a `sent while working` label (an `N files attached` note stays); `/peers` now draws its roster inside the "Waiting for you" picker and writes nothing to the transcript when the picker opens or is dismissed, and when nothing waits for you it writes the screen once as the command's result. Nothing to do on upgrade; to hide the time line, run `/config showTurnDuration off`.
