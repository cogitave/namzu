---
'@namzu/desktop': patch
---

Conversation edits: a changed file's row no longer lets a long path run under its line counts and buttons. A Windows path is split at its backslashes too, so the file name stays readable and the head of the folder is cut with an ellipsis. A file outside the project is written with the home folder as `~`; the full path stays in the tooltip.
