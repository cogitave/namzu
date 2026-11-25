---
"@namzu/sdk": major
---

The hooks that guard a skill's load-time commands now fail closed on a timeout, a skill's own hooks guard its own commands, and a skill that runs as a delegated agent gets no pre-approval where the inline load gets none.

Breaking: a `pre_skill_shell_command` hook that outlasts the lifecycle manager's own limit for a hook (`hookTimeoutMs`) used to warn and let the command run; it now refuses the command, as a `pre_tool_use` hook that times out refuses the shell tool's own call. `skillShellHookVerdict` returns `{ kind: 'refuse', reason: 'the hook timed out' }` for it. To keep a slow guard working, make it answer within the limit or raise `hookTimeoutMs`; there is no setting that lets a command run after its guard timed out.

New: `createPreToolUseShellHook` asks the session's `pre_tool_use` hooks about one shell command, with the fields of the tool's own call, for a host that loads text outside a turn (inside a turn the executor already asks them for the nested call). `SkillHooksPlan.attach` takes an optional `{ prompt }`, so a host learns the delegated prompt when the hooks attach and not when they are read.

The `skill` tool attaches a skill's own hooks before it runs the skill's commands (and takes them off again if the load fails), so a skill's own `pre_skill_shell_command` and `pre_tool_use` entries apply to them. A skill that holds no commands attaches them once its instructions are delivered, as before. A skill with `context: fork` decides what its `allowed-tools` may pre-approve for its own commands from the same plan the inline load uses: when the host withholds the pre-approval (a hook that guards its work could not be read), the delegated load withholds it too.
