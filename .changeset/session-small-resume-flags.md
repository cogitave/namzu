---
"@namzu/cli": minor
---

`namzu` now takes `-c` / `--continue` and `-r` / `--resume [value]` for the interactive session. `-c` opens the most recent conversation in this folder; `--resume` with no value opens the `/resume` picker; with a conversation id it resumes that conversation; with any other value it resumes the conversation of that exact title, or opens the picker searched by the value. Nothing changes for existing use: the flags are new, `namzu exec` keeps its own `--continue` / `--resume`, and `namzu resume <id>` is unchanged. Written before a subcommand or before `resume` they are refused (exit 64), like the other launch flags.
