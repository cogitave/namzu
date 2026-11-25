---
"@namzu/cli": major
---

A command a skill or custom command runs while it loads is now checked by your `pre_tool_use` hooks on every route, a hook that times out refuses it, a skill's own hooks guard its own commands, and a hook that blocks a typed command's expansion leaves nothing run.

Breaking, three changes. First, `pre_tool_use` hooks that match the shell tool are now asked about each load-time command when you type `/name`, run `namzu exec "/name"` or preload a skill into a sub-agent, as they already were when the model loads the skill; a refusal, a request for approval, a rewrite, a crash, a timeout or a stop fails the load. A guard you wrote for `bash` now covers these commands; to let one through, change the guard. Second, a `pre_skill_shell_command` hook that times out refuses its command; it used to warn and let it run. Raise `hookTimeoutMs` or make the hook answer in time to keep a slow guard working. Third, for a typed command the `user_prompt_expansion` hook is now asked before any command runs, so the `prompt` it is shown is the text before the commands' output is put in; it used to be asked afterwards, with the output in place. A hook that read the output from `prompt` should read it from `user_prompt_submit` instead.

A skill's own `hooks:` are attached before its commands run (on a typed command, `namzu exec "/name"` and a streamed `exec --json` command alike) and come off again if the load fails, so its own `pre_skill_shell_command` and `pre_tool_use` entries guard them. A `pre_skill_shell_command` entry in a skill is no longer set aside with a note, except in a skill that runs as a delegated agent (`context: fork`), whose commands run before the agent and its hooks start.
