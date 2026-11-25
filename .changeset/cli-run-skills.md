---
"@namzu/cli": major
---

New built-in skills: `run` starts the project's app and uses it to see a change work (the project's own run skill first, else a pattern for the kind of project, then the project's check as a plain command and one verdict), and `run-skill-generator` writes that per-project skill. Operator-only skills `simplify`, `commit`, `pr`, `update-config`, `fewer-permission-prompts`, `batch`, `debug` and `security-review` are added; the model never starts them on its own and they take no room in its skill list.

`verify-change` is replaced by `run`. Typing `/verify-change`, or a model asking the `skill` tool for it, now gets one line saying it was replaced by `/run`; a skill of that name you wrote yourself still takes precedence and works. `run` keeps the old rule that the project's own check is run as a command of its own so the turn's record can read it.

Breaking for anyone who typed `/run`: that command, which put a shell command from the latest answer in the prompt, is removed. `/run` is now the new skill. To run a command, type `! <command>` in the prompt.

Because a command you may have typed or scripted changes meaning, this release is a major bump for `@namzu/cli`.
