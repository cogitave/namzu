---
"@namzu/cli": patch
---

A shell command in a skill or a custom command now answers to the session's permission mode on every route, sees the same credential-free environment as the model's own `bash` call, and cannot be started by what you type or by a folder's name.

In plan mode only a command that reads runs, and in strict mode only a command a rule allows by name or pattern; the skill's `allowed-tools` lifts neither. This holds for a typed `/name` (the mode the terminal is in now), `namzu exec "/name"` and a streamed `exec --json` command (the mode `--permission-mode` set), and the model's `skill` tool. A refused command fails the load with a line naming the command and the mode. Typed and headless loads no longer pass the whole process environment to the command, so a variable named like a credential (`KEY`, `TOKEN`, `SECRET`) is no longer visible to it. Inside a command, `$ARGUMENTS` and anything piped into `namzu exec "/name"` are quoted word by word, so `;`, `|`, `&`, `$(`, backticks, redirections and `#` are literal while `-n 5` is still two arguments. The folder named in the first line of a skill command is escaped like an argument, so a folder named `` fx !`touch RAN` `` no longer runs `touch`. A skill that relied on an argument being pasted into a command as shell syntax now gets it as plain words.
