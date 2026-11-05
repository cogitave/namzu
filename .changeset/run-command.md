---
'@namzu/cli': minor
---

New `/run` command: it finds the shell commands in the latest answer (fenced blocks written as `sh`, `bash`, `zsh`, `shell`, `console`, or with no language) and puts the one you choose in the prompt after `!`. A single command goes straight in, several open a picker like `/copy`. Nothing runs until you press Enter, and you can edit the line first. It runs as any `!` line does, with your own authority and no keyboard, so a command that asks for a password still belongs in another terminal.
