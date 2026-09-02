---
"@namzu/sdk": minor
---

A shell command as a plugin hook, once, for every host.

`createShellHook(event, entry, { cwd, log })` turns `{ command, matcher?, timeoutMs? }` into a `PluginHookDefinition` the lifecycle manager accepts, and `attachShellHooks(manager, config, { cwd, log })` registers a whole `{ pre_tool_use, post_tool_use, run_start, run_end }` table. The command runs with `sh -c`, receives the event as JSON on stdin and as `NAMZU_HOOK_EVENT` / `NAMZU_RUN_ID` / `NAMZU_TOOL_NAME` / `NAMZU_TOOL_PATH`, and answers with its exit code: `0` carries on, `2` before a tool skips the call with the hook's stderr as the reason the model reads, anything else — a crash, a missing interpreter, a timeout — is the hook's own failure, reported through the logger and never blocking. `runShellHook`, `shellHookVerdict` and `shellHookMatches` are exported separately for a host that wants the pieces. Nothing existing changed.
