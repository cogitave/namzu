---
title: Built-In Tools
description: Reference for the built-in tools exported by @namzu/sdk, including their purpose, safety shape, and common usage patterns.
last_updated: 2026-05-02
status: current
related_packages: ["@namzu/sdk", "@namzu/computer-use"]
---

# Built-In Tools

The SDK ships a practical built-in tool set for local agent workflows. Tool **names mirror Claude Code's canonical table verbatim** (`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`) so Claude's pretrained agentic instincts apply for free — no system-prompt argument needed to explain what `Read` or `Bash` does.

## 1. What `getBuiltinTools()` Returns

`getBuiltinTools()` returns this core set:

- `BashTool`
- `EditTool`
- `GlobTool`
- `GrepTool`
- `ReadFileTool`
- `WriteFileTool`

It does not include:

- `LsTool` — Claude Code's canonical table has no `LS`; directory listing is `Bash` + `Glob`. Still exported for hosts that explicitly want it.
- `SearchToolsTool` — no Claude analogue. Still exported for hosts that explicitly want it.
- `createStructuredOutputTool()` — requires a schema per use case.
- `createComputerUseTool()` — requires a `ComputerUseHost`.

## 2. Built-In Tool Matrix

| Tool | Tool name | Category | Permissions | Read-only | Typical use |
| --- | --- | --- | --- | --- | --- |
| `BashTool` | `Bash` | `shell` | `shell_execute` | No | Run shell commands |
| `ReadFileTool` | `Read` | `filesystem` | `file_read` | Yes | Inspect file contents with optional line slicing |
| `WriteFileTool` | `Write` | `filesystem` | `file_write` | No | Create or overwrite files |
| `EditTool` | `Edit` | `filesystem` | `file_write` | No | Apply exact-string replacements |
| `GlobTool` | `Glob` | `filesystem` | `file_read` | Yes | Find files by pattern |
| `GrepTool` | `Grep` | `analysis` | `file_read` | Yes | Search file contents by regex |
| `LsTool` | `Ls` | `filesystem` | `file_read` | Yes | List directory contents (off-canonical, opt-in) |
| `SearchToolsTool` | `search_tools` | `analysis` | none | Yes | Activate deferred tools by query (off-canonical, opt-in) |

## 3. Path Resolution Rules

Filesystem-oriented built-ins resolve paths relative to `workingDirectory`:

- `Read`
- `Write`
- `Edit`
- `Glob`
- `Grep`
- `Bash`

That means the choice of `workingDirectory` in `AgentInput` is a real execution decision, not a cosmetic field.

## 4. Tool-by-Tool Notes

### 4.1 `Read`

Purpose:

- read a file with line numbers
- optionally slice by `offset` and `limit`

Notes:

- returns numbered lines for easier downstream reasoning
- uses sandbox file reads when a sandbox is available

### 4.2 `Write`

Purpose:

- create or overwrite a file
- create intermediate directories when needed

Notes:

- destructive by declaration
- not concurrency-safe
- sandbox-aware when a sandbox is present

### 4.3 `Edit`

Purpose:

- apply exact-string replacements

Notes:

- fails if `old_string` is missing
- fails if `old_string` is not unique unless `replace_all` is `true`
- useful for targeted edits without rewriting entire files

### 4.4 `Bash`

Purpose:

- run a shell command with timeout control

Notes:

- dangerous command patterns are blocked before execution
- sandbox execution is used when a sandbox exists
- command output is returned as `STDOUT` and `STDERR` sections

### 4.5 `Glob`

Purpose:

- find matching file paths quickly

Notes:

- auto-expands simple patterns into recursive search
- caps result count to keep output manageable

### 4.6 `Grep`

Purpose:

- search file contents by regex

Notes:

- skips large or binary files
- supports context lines
- returns file path plus line number style output

### 4.7 `Ls` (off-canonical)

Purpose:

- inspect directory contents

Notes:

- not in `getBuiltinTools()` defaults — Claude Code's canonical table has no `LS` (directory listing is `Bash` + `Glob`). Hosts that genuinely want it can register the export explicitly.
- supports recursive listing, hidden files, and depth limits
- formats file sizes for readability

### 4.8 `search_tools` (off-canonical)

Purpose:

- search deferred tools and activate them

Notes:

- not in `getBuiltinTools()` defaults — no Claude Code analogue. Available via direct export.
- depends on `toolRegistry` being present in tool context
- keeps the active tool surface smaller until needed

## 5. Registering Built-Ins

```ts
import { ToolRegistry, getBuiltinTools } from '@namzu/sdk'

const tools = new ToolRegistry()
tools.register(getBuiltinTools())
```

You can also mix availability states and opt into the off-canonical extras:

```ts
import {
  ToolRegistry,
  ReadFileTool,
  LsTool,
  BashTool,
  SearchToolsTool,
} from '@namzu/sdk'

const tools = new ToolRegistry()

tools.register([ReadFileTool, LsTool], 'active')
tools.register([BashTool], 'deferred')
tools.register(SearchToolsTool, 'active')
```

This pattern is especially useful when you want:

- cheap read-only discovery tools active by default
- stronger mutating tools activated only on demand

## 6. Structured Output Tool

`createStructuredOutputTool(schema)` is a special built-in factory:

- it creates a `structured_output` tool
- the tool returns validated JSON through the normal tool pipeline
- it is ideal when a final response must match a schema

Use it when you want the model to finish by calling a schema-bound tool instead of producing free-form text.

## 7. Computer Use Tool

`createComputerUseTool(host)` is also a built-in factory:

- it wraps any `ComputerUseHost`
- it exposes one `computer_use` tool
- action support depends on the host's frozen capability map

This tool is documented in more detail in the computer-use section because it depends on `@namzu/computer-use` or another host implementation.

## 8. Recommended Default Tool Set

A practical conservative default for coding or workspace agents is:

1. `ReadFileTool`
2. `GlobTool`
3. `GrepTool`
4. defer `EditTool`, `WriteFileTool`, and `BashTool`

That setup gives the agent strong discovery capability before granting stronger mutation tools.

## 9. Failure Behavior

Built-ins follow the same `ToolResult` contract as custom tools:

- `success: true` for successful execution
- `success: false` plus `error` for actionable failure

They do not throw raw errors across the tool boundary in normal use. This is important for stable runtime behavior and MCP-friendly error surfaces.

## Related

- [SDK Tools](./README.md)
- [Tool Safety](./safety.md)
- [Computer Use](../../computer-use/README.md)
- [Built-In Tools Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/tools/builtins/index.ts)
- [ToolRegistry Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/registry/tool/execute.ts)
