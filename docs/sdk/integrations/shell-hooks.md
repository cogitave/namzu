---
title: Shell hooks
description: Run a shell command before or after a tool call or around a run from a host's configuration, with the event on stdin, a bounded deadline, and exit code 2 as a refusal.
type: Guide
status: stable
resource: packages/sdk/src/plugin/shell-hook.ts
tags: [sdk, integrations]
generated: { by: human:bahadirarda, at: 2026-09-02T00:00:00Z }
---

# Shell hooks

A [plugin hook](./plugins.md) is a JavaScript module. A shell hook is a line
of configuration: a command a host runs at a lifecycle event, with the event
as JSON on stdin. `attachShellHooks` turns a host's hook table into plugin
hooks on a `PluginLifecycleManager`, so the two kinds share one ordering, one
timeout policy and one refusal path.

## Configure

```json
{
  "hooks": {
    "pre_tool_use": [
      { "matcher": "bash", "command": "./scripts/guard-shell.sh", "timeoutMs": 5000 }
    ],
    "post_tool_use": [
      { "matcher": "edit|write", "command": "pnpm biome format --write \"$NAMZU_TOOL_PATH\"" }
    ],
    "run_end": [{ "command": "notify-send 'namzu' 'run finished'" }]
  }
}
```

`ShellHooksConfig` is keyed by event — `pre_tool_use`, `post_tool_use`,
`run_start`, `run_end` — and each entry is a `ShellHookEntry`:

| Field | Meaning |
| --- | --- |
| `command` | Run with `sh -c` in the working directory. |
| `matcher` | Tool names the entry applies to: `*`, one name, or `a\|b\|prefix*`. Absent means every tool. Ignored for run events. |
| `timeoutMs` | Deadline; default `DEFAULT_SHELL_HOOK_TIMEOUT_MS` (30 s), capped at `MAX_SHELL_HOOK_TIMEOUT_MS` (10 min). |

## Attach

```ts sketch
import { attachShellHooks, type ShellHooksConfig } from '@namzu/sdk'

const hooks: ShellHooksConfig = config.hooks ?? {}
const registered = attachShellHooks(manager, hooks, { cwd: workingDirectory })
```

`manager` is the host's `PluginLifecycleManager`; a host with plugins off can
still build one for the hooks alone. The return value is how many hooks were
registered. Every hook is attributed to `SHELL_HOOKS_PLUGIN_ID` unless
`pluginId` names another plugin.

## What the command receives

- stdin: one JSON document — the event name, the run id, and for tool events
  the tool name and its input.
- environment: `NAMZU_HOOK_EVENT`, `NAMZU_RUN_ID`, and for tool events
  `NAMZU_TOOL_NAME` and, when the input names a file, `NAMZU_TOOL_PATH`.
- stdout and stderr are captured, each bounded to 64 KiB.

## What the exit code means

| Exit | `pre_tool_use` | Any other event |
| ---: | --- | --- |
| 0 | continue | continue |
| 2 | **skip the call**; stderr is the reason the model reads | continue; stderr is logged as a warning |
| other | continue; logged as a warning | continue; logged as a warning |

A timed-out or unspawnable hook is a warning, never a refusal: a hook that
cannot run must not be able to stop the agent by accident. Only an explicit
exit 2 before a tool call does that, and only there, because after the call
there is nothing left to refuse.

## Related

- [Plugins and MCP Servers](./plugins.md) — the hook modules these sit beside
