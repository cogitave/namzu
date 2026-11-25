---
"@namzu/cli": patch
---

A command a skill or custom command runs while it loads is now checked by your `pre_tool_use` hooks on every route, a hook that times out refuses it, a skill's own hooks guard its own commands, and a hook that blocks a typed command's expansion leaves nothing run. These tighten the load-time commands that arrive in this same release; nothing an earlier release did changes.

`pre_tool_use` hooks that match the shell tool are asked about each load-time command when you type `/name`, run `namzu exec "/name"` or preload a skill into a sub-agent, as they are when the model loads the skill; a refusal, a request for approval, a rewrite, a crash, a timeout or a stop fails the load. A `pre_skill_shell_command` hook that times out refuses its command; to keep a slow guard working, raise `hookTimeoutMs` or make the hook answer in time. For a typed command the `user_prompt_expansion` hook is asked before any command runs, so the `prompt` it is shown is the text before the commands' output is put in; a hook that wants the output reads it from `user_prompt_submit`.

A skill's own `hooks:` are attached before its commands run (on a typed command, `namzu exec "/name"` and a streamed `exec --json` command alike) and come off again if the load fails, so its own `pre_skill_shell_command` and `pre_tool_use` entries guard them. A `pre_skill_shell_command` entry in a skill that runs as a delegated agent (`context: fork`) is set aside with a note, because its commands run before the agent and its hooks start.
