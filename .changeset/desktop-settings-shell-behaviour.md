---
'@namzu/desktop': patch
'@namzu/cli': patch
---

A setting you save in Settings now reaches new conversations without restarting Namzu; open conversations keep what they started with. Settings shows a plain message and a Try again button on every page when your settings cannot be read, refreshes when the config file changes or the window regains focus, puts a typed value back when you cancel a confirmation or press Use default, finds every row it lists (and none it does not draw), keeps the Tool servers row with a message when no project is open, and shows one Hooks row. When the settings files cannot be read again, a new conversation keeps the last good settings and the reason is written to the log.
