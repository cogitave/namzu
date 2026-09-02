---
"@namzu/cli": minor
---

Shell hooks: one line of config runs a command before or after a tool, or when a run starts or ends.

```yaml
hooks:
  pre_tool_use:
    - matcher: bash
      command: ./scripts/check-command.sh
  post_tool_use:
    - matcher: edit|write
      command: pnpm biome format --write "$NAMZU_TOOL_PATH"
  run_end:
    - command: notify-send namzu "turn settled"
```

A hook runs with `sh -c` in the working directory, receives the event as JSON on stdin (`event`, `tool_name`, `tool_input`, `tool_result`, `run_id`, `cwd`) and as `NAMZU_HOOK_EVENT` / `NAMZU_TOOL_NAME` / `NAMZU_TOOL_PATH` / `NAMZU_RUN_ID` in its environment. Its exit code is its answer: `0` carries on; `2` from a `pre_tool_use` hook **blocks the call** and tells the model why, with the hook's stderr as the reason; any other failure — including a timeout (default 30 s, capped at ten minutes) — is reported on stderr and never blocks. `matcher` is a tool name, a `|`-separated list, or a `prefix*`; absent means every tool. Hooks ride the plugin lifecycle manager, so they run with plugins on or off and take the same `plugins.hookTimeoutMs` ceiling. The key is file-only and never read from the environment, because a hook runs a command with the operator's authority. A hook cannot yet modify a tool's input or replace its result.
