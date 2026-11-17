---
'@namzu/cli': patch
---

The settings Desktop reads from the engine now say what they hold when nothing is saved and when a change takes effect. Switches that are on by default (automatic update install and check, learning suggestions, plugin discovery) no longer read as off while unset, list settings show their ticked defaults, and choices have plain labels with a line of help; the saved values and key names are unchanged. A few descriptions now say what the setting really does (the task list still shows four rows, a recap is written while you are away, memory retirement covers only memories recorded during a turn, skill suggestions are for the terminal app). An older Desktop keeps working: the engine still sends the default in words.
