---
'@namzu/cli': minor
---

A `!` line now runs in the same shell as the model's own `bash` tool instead of always `/bin/sh`: bash where the machine has it (so arrays, `[[ ]]` and process substitution work), the POSIX shell where it does not, and on Windows Git Bash, or the platform shell without it. `NAMZU_BASH_SHELL` still names another shell. A line that depended on a quirk of `/bin/sh` that bash does not share will behave as bash does. The model is also told, in a session with a person typing, that a command the person has to run themselves can be given as one exact line to run here by typing `!` before it; it is told such a line cannot answer a prompt.
