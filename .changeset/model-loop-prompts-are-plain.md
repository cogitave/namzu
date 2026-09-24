---
"@namzu/cli": patch
---

Security fix: a loop the model creates with the `session_loop` tool now sends its prompt to the model as plain text every time it fires. Before, the TUI treated a model loop's prompt like a line you typed: a prompt starting with `!` ran a shell command on your machine, outside the sandbox and without review; `#` saved a project memory; `/` ran a slash command; and a sentence such as "modeli opus-5 yapar mısın" switched the model. A loop fires every interval for up to seven days, so one approval of its creation (none in `auto` mode) could become unreviewed host commands.

Loops you create with `/loop` are unchanged: their `/`, `!` and `#` still work. No loop's prompt is added to the composer's history any more, so Up brings back only what you typed. Nothing to configure; if you relied on a model-created loop running a command, create the loop yourself with `/loop <interval> <command>`.
