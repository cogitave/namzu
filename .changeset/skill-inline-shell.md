---
"@namzu/sdk": minor
"@namzu/cli": minor
---

A skill or a custom command can now hold shell commands that run while its text loads, a new hook event guards each one, and one setting turns them off.

What is new: `` !`cmd` `` inline and a fence opened by three backticks and a bang are run when the text is loaded (a command you type, `namzu exec "/name"`, or the model's `skill` tool), and each is replaced by its trimmed output (with a `[stderr]` block when there is any). `$ARGUMENTS` is put in first, escaped, so a value can never start a command. Each command goes through the shell tool and the session's permission rules, not a second executor: a command a rule denies, or that would need a question, fails the load, and a skill's `allowed-tools` allows its own commands for that load only. A non-zero exit fails the load. Limits are 256 commands, 32 768 characters per command and 4 000 000 characters of output. Project skills and commands run only in a trusted folder, text from a tool server never runs, and a skill preloaded into an agent runs nothing yet. This runs commands from files on your machine at load time, so read a skill you did not write before you use it.

The switch: `disableSkillShellExecution: true` in your config, a project's or the managed file turns all of it off (each command becomes a line saying so); once on, no layer turns it off. The new hook event `pre_skill_shell_command` (`PreSkillShellCommand` in the common shape) is asked after permission and before the command starts and can refuse it or stop the load; with no such hook attached nothing changes.

Nothing is removed. `@namzu/sdk` also adds `findInlineShell`, `substituteEscaped`, `expandInlineShell` and the other pieces a host needs, `createSkillTool({ shell })`, and `allow` and `beforeRun` on `ToolDispatchOptions`; a host that passes no `shell` sees no change.
