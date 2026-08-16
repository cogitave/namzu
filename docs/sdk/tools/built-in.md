---
uid: namzu.sdk.tools.built-in
title: Built-In Tools
description: Reference for the built-in tools exported by @namzu/sdk, including their purpose, safety shape, deadlines, and common usage patterns.
type: Reference
diataxis: reference
owner: cogitave/namzu
status: active
timestamp: 2026-08-10T00:00:00Z
lastReviewed: 2026-08-10
tags: [computer-use, sdk]
---

# Built-In Tools

The SDK ships a practical built-in tool set for local agent workflows. Tool names are the plain verb for what each one does (`bash`, `read`, `write`, `edit`, `glob`, `grep`). A model needs no system-prompt paragraph to work out what `read` reads, so the naming buys prompt budget as well as legibility.

## 1. What `getBuiltinTools()` Returns

`getBuiltinTools()` returns this core set:

- `BashTool`
- `EditTool`
- `GlobTool`
- `GrepTool`
- `ReadFileTool`
- `VerifyOutputsTool` — read-only; confirms a written artifact is where the agent said it is
- `WriteFileTool`

It does not include:

- `LsTool` — not a default: directory listing is `bash` + `glob`, and a third way to list a directory is a third thing for the model to choose between. Still exported for hosts that explicitly want it.
- `SearchToolsTool` — not a default: it exists for progressive disclosure, which a host opts into. Still exported for hosts that explicitly want it.
- `createStructuredOutputTool()` — requires a schema per use case.
- `createComputerUseTool()` — requires a `ComputerUseHost`.

## 2. Built-In Tool Matrix

| Tool | Tool name | Category | Permissions | Read-only | Typical use |
| --- | --- | --- | --- | --- | --- |
| `BashTool` | `bash` | `shell` | `shell_execute` | No | Run shell commands |
| `ReadFileTool` | `read` | `filesystem` | `file_read` | Yes | Inspect file contents with optional line slicing |
| `WriteFileTool` | `write` | `filesystem` | `file_write` | No | Create or overwrite files |
| `EditTool` | `edit` | `filesystem` | `file_write` | No | Apply exact-string replacements |
| `GlobTool` | `glob` | `filesystem` | `file_read` | Yes | Find files by pattern |
| `GrepTool` | `grep` | `analysis` | `file_read` | Yes | Search file contents by regex |
| `LsTool` | `Ls` | `filesystem` | `file_read` | Yes | List directory contents (off-canonical, opt-in) |
| `SearchToolsTool` | `search_tools` | `analysis` | none | Yes | Activate deferred tools by query (off-canonical, opt-in) |

## 3. Path Resolution Rules

Filesystem-oriented built-ins resolve paths relative to `workingDirectory`:

- `read`
- `write`
- `edit`
- `glob`
- `grep`
- `bash`

That means the choice of `workingDirectory` in `AgentInput` is a real execution decision, not a cosmetic field.

## 4. Tool-by-Tool Notes

### 4.1 `read`

Purpose:

- read a file with line numbers
- optionally slice by `offset` and `limit`

Notes:

- returns numbered lines for easier downstream reasoning
- uses sandbox file reads when a sandbox is available

### 4.2 `write`

Purpose:

- create or overwrite a file
- create intermediate directories when needed

Notes:

- accepts exactly `path` and `content`; compatibility aliases are not accepted
- destructive by declaration
- not concurrency-safe
- sandbox-aware when a sandbox is present
- serializes same-process mutations by resolved path
- commits local writes through a same-directory temp file and atomic rename;
  sandbox `writeFile` implementations carry the same atomic replacement
  contract

### 4.3 `edit`

Purpose:

- apply one exact-string replacement

Notes:

- the model is constrained to exactly `path`, `old_string`, `new_string`, and
  optional `replace_all` — one closed shape, so it never has to choose between
  two spellings of the same field
- the host schema additionally accepts the `oldStr` / `newStr` aliases and
  `insertLine`, for hosts that expose replacement under those names
- either way the contract is closed: a field outside it is rejected, not
  silently dropped
- `new_string` may be empty to delete the exact match
- fails if `old_string` is not unique unless `replace_all` is `true`
- normalizes only consistent CRLF/LF boundaries; it does not perform fuzzy matching
- serializes same-process mutations by resolved path
- commits local writes atomically; sandbox writes rely on the `Sandbox`
  interface's atomic replacement guarantee
- useful for targeted edits without rewriting entire files

To append or assemble a long document, write a unique deterministic marker and
replace it with the bounded chunk plus the next marker. Advance markers
monotonically (`{{CHUNK_001}}` → `{{CHUNK_002}}`) so retrying a completed edit
fails safely instead of duplicating content. Distributed hosts must still
assign one writer per file or provide storage-level compare-and-swap.

### 4.4 `bash`

Purpose:

- run a shell command with timeout control

Notes:

- dangerous command patterns are blocked before execution
- sandbox execution is used when a sandbox exists
- command output is returned as `STDOUT` and `STDERR` sections

**A failure reports what happened.** A non-zero exit returns `success: false`
with the exit code on `data.exitCode` and both streams in `output`. A command
that ran out of time is marked separately, `data.timedOut`, because "timed out"
and "exited 1" lead the model to different next moves. The two things an agent
runs a shell for most — a test run and a build — are both non-zero exits, so
this is the ordinary path rather than an edge case.

**One clock, and it is this tool's.** `timeout` defaults to two minutes and is
capped at ten, overridable with `NAMZU_BASH_MAX_TIMEOUT_MS`. A request above the
ceiling is **refused, not clamped** — a number the model was not told had
changed is how it learns to distrust its own arguments. The tool declares an
executor deadline slightly above its own ceiling on purpose, so the executor's
generic per-tool deadline is a backstop rather than a second clock racing this
one.

A caller-owned abort still propagates as an abort rather than being reported as
a command failure.

### 4.5 `glob`

Purpose:

- find matching file paths quickly

Notes:

- auto-expands simple patterns into recursive search
- caps result count to keep output manageable

### 4.6 `grep`

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

- not in `getBuiltinTools()` defaults — directory listing is `bash` + `glob`. Hosts that genuinely want it can register the export explicitly.
- supports recursive listing, hidden files, and depth limits
- formats file sizes for readability

### 4.8 `search_tools` (off-canonical)

Purpose:

- search deferred tools and activate them

Notes:

- not in `getBuiltinTools()` defaults — it serves progressive disclosure, which a host opts into. Available via direct export.
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

A successful call ends the run **only when it is the only call in its turn.** A model that emits `structured_output` alongside other tool calls gets those calls executed and their results delivered back to it, and the run continues — the answer was formed in the same turn as a request for information the model had not yet received, so it is not yet the final one. The next turn produces the answer with those results in hand. This costs one extra turn, and a model avoids it by calling `structured_output` on its own. The same rule already governs a tool marked `terminal`.

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
