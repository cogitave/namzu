---
'@namzu/sdk': minor
---

A shell hook moved from the common hook contract now sees the values it reads, and its answers are read in the shapes it writes. Nothing is removed or renamed; what is added sits beside what was there.

What you can now do:

- Pair a before and an after: `pre_tool_use`, `post_tool_use`, `post_tool_use_failure`, `permission_request` and `permission_denied` carry `tool_use_id`, the id `post_tool_batch` already carried (in process, the optional `PluginHookContext.toolCallId`). A call a tool makes through `dispatchTool` has no model-issued id and carries none.
- Read a file tool's file as `.tool_input.file_path`: for `read`, `write`, `edit`, `grep`, `glob`, `ls`, `view_image` and `lsp` the input has `file_path` with the same value as `path`. A `pre_tool_use` rewrite that echoes it is read: if one of the two keys changed, that is the new path; two different values make the answer unreadable.
- Answer `updatedToolOutput` with any JSON type: a string, an object shaped like the result (`output`, optional `success` and `error`), any other object, array, number or boolean (shown as JSON text), or `null` for no replacement. It is also read on `post_tool_use_failure`, and `updatedMCPToolOutput` is read for tool-server tools (`updatedToolOutput` wins when both are set). The documentation lists every remaining way a replacement can leave the original result shown, and what `onFailure` does for each.
- Write `if: "Agent"`, `Task`, `Edit|Write`, `mcp__github__*`: the tool part takes every spelling a `matcher` list takes, and the sub-agent tool `Agent` is named by `Agent` and `Task`. A shell-command `if` matches through `env`, `sudo`, `nohup`, `xargs`, `find -exec`, a full program path and git's global options, and runs the hook for a command whose name is only known at run time.
- `matcher` reads a glob in the middle of a name (`mcp__*__get_issue`) and a bare tool-server name (`mcp__github`), and a name without its `_` (`ViewImage`). New exports: `shellHookMatcherProblem`, `shellHookIfProblem`, `ShellHookCall`. `QueryAgentConfig.agentType` names the agent to `subagent_start` and `subagent_stop` hooks.
- `subagent_stop` now carries `agentType` on every path a child's turn ends by.

What changes for a config that works today, and what to do:

- A `matcher` that is not a valid regular expression used to match nothing, so its hook never ran; it now matches every name, so the hook runs. Fix the pattern (`namzu doctor` and `/hooks` now say which one), or attach the hook with an `if`.
- A `matcher` of `Task` now also fires for the sub-agent tool `Agent`.
- An `updatedToolOutput` that is not a string used to make the whole answer unreadable (and, with `onFailure: continue`, show the original result); it is now the replacement.
- A hook that reads `tool_input` strictly, comparing the whole object, sees the added `file_path`.
