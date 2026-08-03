---
title: SDK Tools
description: Define tools, register them in ToolRegistry, and understand built-in tool behavior in @namzu/sdk.
last_updated: 2026-08-03
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
| `inputSchema` | Zod schema used for runtime validation and default JSON Schema generation |
| `modelInputSchema` | Optional canonical JSON Schema shown to models instead of the runtime compatibility schema |
| `enforceModelInput` | Requests constrained input generation on capable providers; requires `modelInputSchema` |
| `validationErrorHint` | Optional model-facing retry guidance for conditional schemas whose accepted shapes are not clear from top-level required fields |
| `category` | High-level grouping such as `filesystem`, `shell`, `network`, `analysis`, or `custom` |
| `permissions` | Declared capability list such as `file_read` or `network_access` |
| `readOnly` | Declares whether the tool should be treated as non-mutating |
| `destructive` | Signals whether the tool performs a risky action |
| `concurrencySafe` | Signals whether concurrent execution is safe |
| `timeoutMs` | Optional per-execution deadline, overriding the run default |
| `maxRetries` | Optional in-loop retry budget for a failed execution (see §7c) |
| `outputSchema` | Optional JSON Schema of the return shape, appended to the description the model sees |
| `terminal` | Optional; settle the run with this tool's output instead of looping again (see §7d) |

If `execute()` throws, the SDK converts that throw into a structured failed tool result instead of leaking an uncaught error through the tool boundary.

When `inputSchema` rejects a call, `ToolRegistry` appends
`validationErrorHint` to the structured failure. Keep the hint concise and
include one complete safe payload:

```ts
validationErrorHint:
  'Required shape: {"path":"file.md","old_string":"exact text","new_string":"replacement"}.',
```

### Publish a provider-safe model contract

Use `modelInputSchema` when the generated Zod JSON Schema includes constraints
outside a provider's constrained-decoding subset. `ToolRegistry` publishes this
reviewed override through `toLLMTools()` while runtime execution remains
authoritative:

```ts
const editLike = defineTool({
  name: 'edit_like',
  description: 'Replace exact text in a file.',
  inputSchema: z
    .object({
      path: z.string().min(1),
      old_string: z.string().min(1),
      new_string: z.string(),
    })
    .strict(),
  modelInputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  enforceModelInput: true,
  category: 'filesystem',
  permissions: ['file_write'],
  readOnly: false,
  destructive: false,
  concurrencySafe: false,
  async execute(input) {
    return { success: true, output: input.path }
  },
})
```

The built-in `edit` and `write` tools deliberately expose the same single
canonical shape at both boundaries:

- `edit`: `path`, `old_string`, `new_string`, optional `replace_all`
- `write`: `path`, `content`

They do not accept aliases or combine exact replacement with line-number
insertion. For append-like work, replace a unique tail or deterministic rolling
marker with itself plus the new content.

`enforceModelInput: true` without an explicit `modelInputSchema` is rejected at
registration. Namzu does not assume a Zod-generated schema is compatible with
every provider's constrained-decoding subset.

The agent runtime carries enforced tool names to providers through
`ChatCompletionParams.enforceToolInputSchema`. This property is a non-wire
provider hint: custom `LLMProvider` implementations must consume or strip it
instead of serializing `ChatCompletionParams` wholesale.

Native Anthropic and the HTTP provider's Anthropic dialect enable strict tool
use for documented Claude 4.5+ model identifiers. Their `strictToolUse`
configuration accepts:

- `"auto"` (default): enable only for recognized compatible models
- `"on"`: opt a compatible proxy/model alias in
- `"off"`: disable constrained tool inputs

Runtime validation always remains authoritative. Anthropic's strict JSON
Schema subset does not grammar-enforce constraints such as `minimum`, so those
constraints belong in descriptions and the runtime decoder. Anthropic also
limits one request to 20 strict tools, 24 optional parameters, and 16 union
parameters. Compiled schemas are cached for up to 24 hours; do not place PHI
in schema property names, enum/const values, or regex patterns.

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
| `report` | Say how far along you are, for a host rendering a live view |
| `requestPause` | Raise a durable pause and wait for a human (see §3a) |

This is the boundary between a simple helper function and a real runtime tool.

### 3a. Pausing for a Human

A tool with a real-world consequence — a spend, an outbound post, a
destructive migration — usually wants its OWN confirmation with its own
wording, not the generic tool-review gate:

```ts
const outcome = await context.requestPause?.({
  name: 'target_environment',
  prompt: 'Which environment should this deploy run against?',
  options: [
    { id: 'staging', label: 'Staging (Recommended)' },
    { id: 'production', label: 'Production', description: 'Live traffic' },
  ],
})

if (outcome?.status !== 'answered') {
  return { success: false, output: '', error: 'no environment was chosen' }
}
```

The pause becomes a real checkpoint, so it appears on every surface a
tool-review park appears on and survives the process dying. On resume the
answer is routed back **by name**, so several tools pausing in one batch
each get their own and one call may pause more than once ("which
environment", then "are you sure").

`status` is one of `answered`, `unanswered`, or `aborted`. Silence is not
a variant of `answered` with an empty selection: a tool that asks "may I
charge this card" and reads silence as yes is worse than one that never
asked, so the absence of an answer has its own shape and cannot be
destructured into consent. An option id the tool did not offer is dropped
for the same reason.

`requestPause` is optional on the context — a host calling a tool
directly, outside a run, provides no route to a human. Write the tool so
it can decide what to do without one.

Before this, the pause machinery was reachable from exactly four
kernel-owned points: the plan gate, the tool-review gate, the iteration
cadence, and the built-in `ask_user_question` tool.

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

## 7c. Failing and Recovering

**Retryable failures.** A tool may declare `maxRetries` and mark a result
`retryable: true`, and the executor will re-run it in-loop instead of
sending the error back for the model to re-decide.

```ts
defineTool({
  name: 'fetch_page',
  maxRetries: 2,
  execute: async () => ({
    success: false, output: '', error: 'ECONNRESET', retryable: true,
  }),
  // …
})
```

`maxRetries` **defaults to 0, and that default is load-bearing.** Retrying
is only safe if the tool is idempotent, and the SDK cannot know that:
silently re-running a write, a `git push` or a payment call is worse than
never retrying at all. Even opted in, only failures marked `retryable` are
retried — a missing file will not appear on the second attempt, and burning
the budget on it just delays the error the model needs to see.

**Repairing a malformed call.** `query({ repairToolCall })` gets a last
look before the error reaches the model, and may rewrite the arguments and
the tool name. See
[Loop Control §9](../runtime/loop-control.md#9-repairing-a-bad-tool-call).

## 7c-bis. Making a Malformed Call Impossible

§7c repairs a call whose arguments do not match the schema. Some
endpoints can make that unnecessary: they constrain decoding to the
schema, so invalid arguments cannot be emitted at all.

```ts
new OpenAIProvider({ apiKey, strictTools: true })
```

Off by default, and the reason is a real trade rather than caution.
Strict decoding requires **every** property to be required, so the driver
rewrites each schema: objects close, every property joins `required`, and
one that was optional widens to accept `null` so "leave it out" stays
expressible. An optional argument therefore becomes one the model must
pass explicitly as null — a change to what the model is told, which
belongs to the tool's author rather than the driver.

The rewrite is not separable from the flag: the endpoint rejects strict
mode on a schema that has not been closed for it, so sending one without
the other turns a correctness feature into a 400.

## 7d. Settling on a Tool's Output

A tool declared `terminal: true` ends the run with its own output instead
of handing control back to the model:

```ts
defineTool({
  name: 'ask_specialist',
  terminal: true,
  // …
})
```

Delegation is blocking — the worker's final text comes back as the
dispatching call's result — so without this the loop went round once more
purely to restate what the worker already said. That relay costs a full
model call at the parent's context size, the most expensive call in the
run, and it is lossy: the parent paraphrases through its own (compacted)
view, so the caller receives the parent's summary rather than the
specialist's answer. For a router, whose entire job is to pick a
specialist, that doubled the cost of every request.

It is honoured only when the terminal call is the **only** call in the
turn and it did not fail. A model that asked for other work in the same
turn meant to see those results, and ending the run would discard answers
it requested; an error is not an answer either, and the model is the one
that should read it. Both cases take the ordinary path and say so in the
log.

Child progress is already visible without this: a subagent's run events
reach the same `RunEventListener` the parent was given, stamped with
lineage depth, so a host sees the worker working rather than a silence.

`buildAgentTool({ terminal: true })` sets it on the built-in `Agent`
delegation tool. Off by default — an agent that delegates as one step of a
longer plan needs the loop to continue.

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
