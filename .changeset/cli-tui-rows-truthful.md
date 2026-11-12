---
'@namzu/cli': minor
---

Rows in the terminal read more truthfully. Your own message is one block on a quiet tint with a dimmer `›`, easier to find when scrolling back (a message queued and not yet sent is on a plainer grey); with `NO_COLOR`, a CI run, fewer than 256 colours or the `-ansi` themes nothing is tinted and the row looks as before. When you press Esc on a running command, its `● Bash(…)` row now stays above the `Interrupted` line instead of vanishing, and in fullscreen that line sits in the same columns as every other `⎿` result row. An open line of reads and searches shows the newest item as it starts, not a name that cycles every 0.7 seconds, and in fullscreen it carries the open hint too. The closing outcome line no longer says "A command ran that may have changed files" after a command you declined or a mere launch of a background sub-agent. There is no setting for any of this and nothing to change in your configuration.
