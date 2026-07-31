---
title: SDK Tools
description: Define tools, register them in ToolRegistry, and understand built-in tool behavior in @namzu/sdk.
last_updated: 2026-07-31
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
| `timeoutMs` | Optional per-execution deadline, overriding the run default |

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
| `parentSpan` | Span to parent this tool's OpenTelemetry span to |

This is the boundary between a simple helper function and a real runtime tool.

## 4. Register Tools

`ToolRegistry` owns registration, availability state, and prompt conversion:

```ts
import { ToolRegistry, ReadFileTool, WriteFileTool } from '@namzu/sdk'

const tools = new ToolRegistry()

tools.register(ReadFileTool)
tools.register(WriteFileTool, 'deferred')

tools.activate(['Write'])
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

## 7. Structured Output

Pass `structuredOutput` to `query()` when the final answer must match a schema. The runtime registers a schema-bound tool, validates the call, puts the parsed value on `Run.structuredOutput`, and ends the run there.

```ts
const run = await runToCompletion(
  query({
    provider,
    tools,
    structuredOutput: {
      schema: z.object({
        verdict: z.enum(['pass', 'fail']),
        findings: z.array(z.string()),
      }),
      // Re-prompts before giving up. Default: 2.
      maxRetries: 2,
    },
    // …
  }),
)

run.structuredOutput // { verdict, findings } — already validated
```

A model that answers in prose instead is re-prompted. If it still will not comply within `maxRetries`, the run settles with `stopReason: 'structured_output_failed'` rather than grinding against `maxIterations` — you get a clear failure instead of an expensive one.

The tool is registered from iteration zero, never injected late. Tools render at prompt-cache prefix position 0, so adding one mid-run would invalidate the cached prefix for every remaining turn.

This is especially useful for:

- extraction workflows
- classification outputs
- MCP-friendly machine-readable responses
- UI payload generation

`createStructuredOutputTool(schema)` remains exported if you want to register and drive the tool yourself.

## 7a. Tool Results Can Carry More Than Text

`ToolResult.output` is the text form — what the host, the transcript and compaction see. When the model needs something a string cannot carry, set `content` as well:

```ts
return {
  success: true,
  output: 'Screenshot captured (1920x1080, image/png).',
  content: [
    { type: 'text', text: 'Screenshot captured.' },
    { type: 'image', data: base64Png, mediaType: 'image/png' },
  ],
}
```

The two channels are separate on purpose: a host UI wants the description, the model wants the pixels. Drivers that cannot express non-text results (`@namzu/openai`, `@namzu/ollama`) degrade to an explicit `[image: …]` placeholder rather than dumping base64 into the conversation.

Failed results are marked on the wire as well — `is_error` on Anthropic, `status: 'error'` on Bedrock — so the model's tool-failure recovery behavior fires instead of relying on prose formatting.

## 7b. Deadlines and Output Budgets

Two runtime bounds apply to every tool, with no configuration required.

**Deadline.** Tools get 120 seconds by default (`toolTimeoutMs` on `query()`, or `timeoutMs` per tool). On expiry the executor stops waiting and returns a model-visible error result, so the agent can route around a slow dependency instead of losing the turn. `context.abortSignal` fires at the same moment, so a cooperative tool actually stops working — `bash` passes it to the child process.

**Output budget.** A single tool result is capped at 40,000 model-visible characters (`maxToolOutputChars`; `0` disables). Over-budget output is written to `<runDir>/tool-output/<toolUseId>.txt` and replaced with a head+tail preview naming the path, so nothing is lost and tokens are paid only if the agent decides the rest is worth re-reading — with `read` and `grep`, tools it already has.

Relatedly, `read` returns the first 2000 lines when given no window, and says so with a `[PARTIAL view — lines X-Y of Z]` notice naming the exact next call. A truncated read that looks like a short file is the most expensive silent failure a read tool can have.

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
