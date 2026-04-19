---
title: SDK Tools
description: Define tools, register them in ToolRegistry, and understand built-in tool behavior in @namzu/sdk.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk", "@namzu/computer-use"]
---

# SDK Tools

The tool system is one of the main extension surfaces in Namzu. A tool in Namzu is not just a function. It is a typed runtime boundary with input validation, safety declarations, prompt-facing schema generation, and execution through `ToolRegistry`.

## 1. Define a Tool

Use `defineTool()` to build a tool from public SDK primitives:

```ts
import { defineTool } from '@namzu/sdk'
import { z } from 'zod'

const summarizeText = defineTool({
  name: 'summarize_text',
  description: 'Summarize the provided text into a short paragraph.',
  inputSchema: z.object({
    text: z.string(),
  }),
  category: 'analysis',
  permissions: [],
  readOnly: true,
  destructive: false,
  concurrencySafe: true,
  async execute({ text }) {
    return {
      success: true,
      output: text.slice(0, 200),
    }
  },
})
```

## 2. Required Tool Metadata

`defineTool()` asks you to declare more than just an `execute()` function:

| Field | Purpose |
| --- | --- |
| `name` | Stable snake_case identifier exposed to the model |
| `description` | Prompt-facing summary of when to use the tool |
| `inputSchema` | Zod schema used for validation and JSON Schema generation |
| `category` | High-level grouping such as `filesystem`, `shell`, `network`, `analysis`, or `custom` |
| `permissions` | Declared capability list such as `file_read` or `network_access` |
| `readOnly` | Declares whether the tool should be treated as non-mutating |
| `destructive` | Signals whether the tool performs a risky action |
| `concurrencySafe` | Signals whether concurrent execution is safe |

If `execute()` throws, the SDK converts that throw into a structured failed tool result instead of leaking an uncaught error through the tool boundary.

## 3. Tool Context

`execute(input, context)` receives a `ToolContext` object. Important fields include:

| Field | Why it matters |
| --- | --- |
| `runId` | Identify the current run |
| `workingDirectory` | Base path for local filesystem behavior |
| `abortSignal` | Cancellation propagation |
| `env` | Controlled environment variables |
| `permissionContext` | Runtime permission mode information |
| `toolRegistry` | Lets tools such as `search_tools` activate deferred tools |
| `sandbox` | Lets sandbox-aware tools read, write, or execute inside containment |

This is the boundary between a simple helper function and a real runtime tool.

## 4. Register Tools

`ToolRegistry` owns registration, availability state, and prompt conversion:

```ts
import { ToolRegistry, ReadFileTool, WriteFileTool } from '@namzu/sdk'

const tools = new ToolRegistry()

tools.register(ReadFileTool)
tools.register(WriteFileTool, 'deferred')

tools.activate(['write_file'])
```

The registry tracks three availability states:

| State | Meaning |
| --- | --- |
| `active` | Visible and callable |
| `deferred` | Hidden from direct execution until activated |
| `suspended` | Known to the runtime but not currently callable |

## 5. Built-In Tools

The SDK exports a set of built-in tools that cover common local workflows:

| Tool | Purpose |
| --- | --- |
| `ReadFileTool` | Read a file |
| `WriteFileTool` | Write a file |
| `EditTool` | Apply targeted edits |
| `BashTool` | Run shell commands |
| `GlobTool` | Match filesystem paths |
| `GrepTool` | Search text content |
| `LsTool` | List directory contents |
| `SearchToolsTool` | Search deferred tools by name or description |
| `createStructuredOutputTool()` | Create a schema-bound output tool for a specific use case |
| `createComputerUseTool()` | Wrap a `ComputerUseHost` as the `computer_use` tool |

Read [Built-In Tools](./built-in.md) for a deeper reference on each built-in tool and its safety shape.

## 6. Deferred Tools and Progressive Disclosure

One of the most important runtime behaviors is that tools do not need to be visible all at once.

Typical pattern:

```ts
tools.register([ReadFileTool, LsTool, SearchToolsTool], 'active')
tools.register([EditTool, WriteFileTool, BashTool], 'deferred')
```

That gives the runtime:

- cheap discovery tools immediately
- stronger mutation tools only when the agent can justify loading them

## 7. Structured Output Tool

`createStructuredOutputTool(schema)` is a tool factory used when the final answer must match a schema. Instead of asking the model to format JSON in plain text, the runtime can force the model to call a schema-bound tool.

This is especially useful for:

- extraction workflows
- classification outputs
- MCP-friendly machine-readable responses
- UI payload generation

## 8. Computer Use Is a Tool Factory, Not a Separate Runtime

Desktop control plugs into the same registry model as every other tool:

```ts
import { ToolRegistry, createComputerUseTool } from '@namzu/sdk'
import { SubprocessComputerUseHost } from '@namzu/computer-use'

const host = new SubprocessComputerUseHost()
await host.initialize()

const tools = new ToolRegistry()
tools.register(createComputerUseTool(host))
```

This keeps GUI automation inside the standard tool pipeline instead of creating a second runtime path.

## 9. Safety and Policy

Tool execution is shaped by more than the tool function itself:

- `permissionMode: 'plan'` blocks non-read-only tools
- `VerificationGate` can allow, deny, or review a tool call
- sandbox-aware tools can execute inside a constrained environment
- destructive flags can feed HITL or other policy layers

Read [Tool Safety](./safety.md) for the full decision path.

## Related

- [SDK Quickstart](../quickstart.md)
- [Built-In Tools](./built-in.md)
- [Connectors and MCP](../integrations/connectors-and-mcp.md)
- [Tool Safety](./safety.md)
- [SDK Runtime](../runtime/README.md)
- [Computer Use](../../computer-use/README.md)
- [defineTool Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/tools/defineTool.ts)
- [ToolRegistry Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/registry/tool/execute.ts)
