---
'@namzu/sdk': minor
---

A shell hook entry can ask for the tool names a person writes in a matcher. Nothing is removed or renamed and no default changes.

What you can now do:

- Give an entry `toolNames: 'written'` (type `ShellHookToolNames`, on every entry kind) and its hook is sent `Bash`, `Edit`, `WebFetch` as `tool_name`, as `NAMZU_TOOL_NAME` and inside `tool_calls` on `post_tool_batch`, so a script that tests `tool_name == "Bash"` works unchanged. `toolNames: 'namzu'`, or no key, keeps the name the tool is registered under (`bash`). A tool with no common name (`job`, `view_image`) and every tool-server tool keep their own names; nothing else in the payload depends on the key, and `matcher` and `if` read either spelling whichever you choose.
- Use the same table yourself: `SHELL_HOOK_WRITTEN_TOOL_NAMES` and `shellHookToolName(name, mode)`. `SHELL_HOOK_PASCAL_EVENT_NAMES` is the table of PascalCase event names (`PreToolUse`) a host needs to read a hooks block written in the common shape; `attachShellHooks` still takes entries of the SDK's own shape only, and the reading of the other shape is the host's.

Nothing you must do.
