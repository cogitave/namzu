---
'@namzu/cli': patch
---

Shell commands in the terminal now read like Claude Code's: a green or red dot in front of `Bash(command)` instead of a tick and a duration, the command's line breaks kept in the header, and the output hung under `⎿` as its first three lines followed by `… +N lines (ctrl+o to expand)`. A failed command now shows its error output and `Exit code N` instead of repeating the command, an empty result reads `(No output)`, and a command moved to a background job reads `Running in the background` instead of the instructions meant for the model. While a command runs it shows `Running…` with the elapsed time.
