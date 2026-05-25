---
'@namzu/cli': patch
---

**Fix runaway interrupts and overflowing tool output.**

- `Ctrl+C` while the agent is working now reliably stops it: it aborts the turn, **clears any queued messages** (so the queue can't immediately restart a new turn), and drops the abort handle so a second `Ctrl+C` arms exit. Previously, repeated presses spammed "Interrupted." lines and a queued message kept the agent running.
- The user-interrupt no longer prints a redundant `Error: aborted` (the `Interrupted.` line covers it).
- Tool diff/output lines now wrap to the terminal width instead of running off the right edge.
