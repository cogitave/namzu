---
"@namzu/computer-use": minor
---

Fixes found in review of the native Windows helper, which is still opt-in behind `NAMZU_WIN_HELPER`, so nothing changes unless that variable is set and nothing needs doing on upgrade. With it set, the foreground ladder and the display adapter now share one helper process, so the lease a burst begins applies to the input it sends (before, each had its own helper and the lease never applied); a burst for the desktop watches the window in front when it starts. The helper refuses a point that is on no monitor in an L-shaped layout, puts back up the buttons and keys of a plan the system took only part of, and says a minimized window cannot be captured instead of returning a title-bar stub. Pressing Escape does not yet stop a burst on the native helper (the PowerShell monitor did); that is why it stays opt-in.
