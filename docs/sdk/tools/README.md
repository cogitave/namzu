---
uid: namzu.sdk.tools.readme
title: SDK Tools
description: Define tools, register them in ToolRegistry, and understand built-in tool behavior in @namzu/sdk.
type: Guide
diataxis: explanation
owner: cogitave/namzu
status: active
timestamp: 2026-08-20T00:00:00Z
lastReviewed: 2026-08-31
tags: [computer-use, sdk]
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
| `presentCall` | Optional host-facing call view; a generic view may set `presentation: 'activity'` when its label is already complete |
| `presentResult` | Optional host-facing result view; a generic successful acknowledgement may set `visibility: 'hidden'` |

Presentation metadata is advisory and backward compatible. A host that does not
understand it still renders the generic label. A host that does can avoid
wrapping a human activity in an implementation name and can omit a redundant
successful acknowledgement. Failures must remain visible even when a presenter
requested hidden visibility.

If `execute()` throws, the SDK converts that throw into a structured failed tool result instead of leaking an uncaught error through the tool boundary.

When `inputSchema` rejects a call, `ToolRegistry` appends
`validationErrorHint` to the structured failure. Keep the hint concise and
include one complete safe payload:

```ts sketch
validationErrorHint:
  'Required shape: {"path":"file.md","old_string":"exact text","new_string":"replacement"}.',
```

The schema's parsed value is also the authorization boundary. The runtime
parses or transforms once, detaches the result as a JSON-value graph, shows an
independent frozen projection to policy and review, then executes the retained
value without parsing again. This means a transform must return null,
booleans, finite numbers, strings, arrays or plain objects. Dates, maps, shared
buffers, accessors, cycles and other process-local mutable values are refused.

This is observable when a schema uses `.transform()`: `execute()` receives the
transformed value, and authorization rules and the human approval surface see
that same value rather than the provider's raw input. A retry does not invoke
the transform a second time.

### Publish a provider-safe model contract

Use `modelInputSchema` when the generated Zod JSON Schema includes constraints
outside a provider's constrained-decoding subset. `ToolRegistry` publishes this
reviewed override through `toLLMTools()` while runtime execution remains
authoritative:

```ts
import { defineTool } from '@namzu/sdk'
import { z } from 'zod'

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

The built-in `edit` and `write` tools deliberately expose ONE canonical shape to
the model, narrower than what the host boundary accepts:

- `edit`: `path`, `old_string`, `new_string`, optional `replace_all`,
  optional `insertLine`, optional `edits`
- `write`: `path`, `content`

The narrowing is about spellings, not about capability. The host schema also
accepts the `oldStr` / `newStr` aliases, because hosts that expose replacement
under those names are real; the model-facing schema does not, because offering a
model two names for one field is how it learns to guess between them. Both are
closed — a field outside either is rejected, never silently dropped.

For a change that spans several places in one file, send the whole thing as
`edits` rather than as several calls: applied in order, committed as one write,
and refused entirely if any entry does not apply.

`enforceModelInput: true` without an explicit `modelInputSchema` is rejected at
registration. Namzu does not assume a Zod-generated schema is compatible with
every provider's constrained-decoding subset.

Registration also rejects a `modelInputSchema` that asks for enforcement it
cannot carry. A keyword outside the constrained-decoding subset is not degraded
— the provider rejects the **whole** request, so one unexpressible field in one
tool takes down every other tool in the call. The subset is measured against the
live wire rather than transcribed from a page, and the parts worth knowing:

| Construct | Under `enforceModelInput` |
| --- | --- |
| `minLength`, `maxLength`, `pattern`, `format`, `const`, `enum`, `anyOf` | accepted |
| `minItems` | accepted at `0` or `1` only |
| `oneOf`, `not`, `if`/`then`/`else` | rejected — use `anyOf`, or validate at execution |
| `minimum`, `maximum`, `multipleOf` | rejected — enforce at execution |
| `maxItems`, `uniqueItems` | rejected — enforce at execution |
| a tuple (`prefixItems`, or draft-07 `items: [a, b]`) | rejected — cannot be expressed |
| `additionalProperties` | accepted only as `false` |

A tuple is the one case that no rewriting rescues, so a tool that needs both a
tuple field and enforced input has to give up one of them.

### Schema dialects are a property of the wire

Tool schemas are rendered once, canonically, as JSON Schema draft-07, and each
driver converts at the boundary where it knows which wire it is about to talk
to. This matters because the dialects disagree about tuples: draft-07 spells one
`items: [a, b]`, while 2020-12 — which some wires require for tool input — spells
it `prefixItems: [a, b]` and gives `items` a different meaning. A wire that wants
2020-12 rejects the draft-07 spelling outright, and rejects the entire request
with it.

If you assemble a tool payload yourself rather than going through a driver, the
same three functions are exported:

```ts
import { renderToolSchema, toSchemaDialect, findDraft07Only } from '@namzu/sdk'

import { z } from 'zod'

const inputSchema = z.object({ path: z.string() })

const rendered = renderToolSchema(inputSchema) // memoized, frozen, draft-07
const forThisWire = toSchemaDialect(rendered, '2020-12')

findDraft07Only(forThisWire) // [] — nothing a 2020-12 parser will refuse
```

`renderToolSchema` is what `toLLMTools()` uses: it strips `$schema`, memoizes on
the Zod object and deep-freezes the result. Use it rather than calling
`zodToJsonSchema` yourself — the tools block renders at position 0 of the
prompt-cache prefix, so a differently-ordered but equal object invalidates the
cache for the whole run.

The agent runtime carries enforced tool names to providers through
`ChatCompletionParams.enforceToolInputSchema`. This property is a non-wire
provider hint: custom `LLMProvider` implementations must consume or strip it
instead of serializing `ChatCompletionParams` wholesale.

Native Anthropic and the HTTP provider's Anthropic dialect enable strict tool
use for the model identifiers that document support for it. Their `strictToolUse`
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
| `toolUseId` | Identify this exact execution, including a child dispatched by another tool |
| `source` | Distinguish a model-direct, nested, or `run_code` invocation |
| `dispatchTool` | Invoke another granted tool through this invocation's bounded registry and authorization path |

This is the boundary between a simple helper function and a real runtime tool.

### 3a. Pausing for a Human

A tool with a real-world consequence — a spend, an outbound post, a
destructive migration — usually wants its OWN confirmation with its own
wording, not the generic tool-review gate:

```ts
import type { ToolContext, ToolResult } from '@namzu/sdk'

async function execute(context: ToolContext): Promise<ToolResult> {
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

  return { success: true, output: `deploying to ${outcome.selectedOptionIds[0]}` }
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

### 3b. Nested and code-runtime calls

An executor-owned `ToolContext.source` is one of:

- `{kind: 'direct'}` for a model-issued call;
- `{kind: 'nested', parentToolUseId}` for one tool dispatching another; or
- `{kind: 'code', parentToolUseId, runtimeToolCallId}` for a call made by a
  model-authored program running inside `run_code`.

The child receives its own `toolUseId`, progress publisher and deadline. Its
durable `requestPause` route intentionally remains bound to the nearest
model-issued ancestor: that is the call present in the checkpoint transcript
and therefore the identity a fresh process can re-enter. Its
`tool_executing`/`tool_completed` events carry `via` naming the actual parent
tool and parent call id; code-runtime children additionally carry the runtime's
per-program call id. This is lineage, not input: a tool may narrow the operation
signal supplied to `dispatchTool`, but the executor chooses the ephemeral child
id and derives the parent from the context it already issued.

`dispatchTool` is an invocation capability, not a session handle. It closes
when the parent returns, throws, times out, or is cancelled. Child calls already
admitted at that point receive cancellation and reach their executor-owned
terminal event before the parent is reported complete; a retained callback is
refused before it can mint a new event or touch the registry. If the run has an
`AuthorizationGate`, every child is evaluated by the same gate. Only `allow`
proceeds. `deny` and `review` leave a durable refusal because a nested call
cannot create another human-review checkpoint while its parent is executing.

Nested text crosses back to the caller only after the same
`maxToolOutputChars` budget used for a direct model-visible result. The raw
result remains available to the run's project-instruction observer, while the
program and nested terminal event receive the bounded projection and its
original-length/truncation metadata. Setting the budget to `0` retains the
documented compatibility mode and disables this reduction.

Custom `CodeRuntime` implementations have one migration requirement: call
`onHostCall(request, context)` with a unique `context.runtimeToolCallId` and an
operation-owned `context.signal`. Revoke that signal when the caller cancels or
the program deadline expires. The package root now exports `CodeRuntime`,
`RunCodeOptions`, `HostCallContext`, `WorkerCodeRuntime` and the related result
types so a custom backend does not need a deep import. The shipped worker also
waits for already-admitted host calls before reporting a normal program
completion; a JavaScript body returning is not evidence that an un-awaited
effect has finished.

`ask_user_question` is published only to a depth-zero/root
`SupervisorAgent`. A delegated supervisor cannot receive it, including from a
pre-registered host tool with the same name. Its inherited `resumeHandler`
still serves tool review: removing operator questions from workers must not
turn REVIEW-tier calls into unattended approvals. The root receives the
worker's result and owns any follow-up question to the operator.

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
import {
  BashTool,
  EditTool,
  LsTool,
  ReadFileTool,
  SearchToolsTool,
  ToolRegistry,
  WriteFileTool,
} from '@namzu/sdk'

const tools = new ToolRegistry()

tools.register([ReadFileTool, LsTool, SearchToolsTool], 'active')
tools.register([EditTool, WriteFileTool, BashTool], 'deferred')
```

That gives the runtime:

- cheap discovery tools immediately
- stronger mutation tools only when the agent can justify loading them

## 7. Structured Output

Pass `structuredOutput` to `query()` when the final answer must match a schema. The runtime registers a schema-bound tool, validates the call, puts the parsed value on `Run.structuredOutput`, and ends the run there.

```ts
import { drainQuery, type QueryParams } from '@namzu/sdk'
import { z } from 'zod'

declare const rest: Omit<QueryParams, 'structuredOutput'>

const run = await drainQuery({
  ...rest,
  structuredOutput: {
    schema: z.object({
      verdict: z.enum(['pass', 'fail']),
      findings: z.array(z.string()),
    }),
    // Re-prompts before giving up. Default: 2.
    maxRetries: 2,
  },
})

run.structuredOutput // { verdict, findings } — already validated
run.result           // the same value, serialized
```

`run.result` carries `JSON.stringify(structuredOutput)` on a structured run. It used to hold whatever prose an *earlier* turn produced — result resolution walks back from the message tail and stops at the first non-assistant message, and a structured run's last assistant turn is a tool call — so a host reading it got a sentence from the middle of the run presented as the answer. Read `run.messages` if you want the model's last prose.

### It reaches a caller, not just the run

The same value comes back through every boundary above `query()`:

```ts
import { runAgent, type LLMProvider } from '@namzu/sdk'
import type { z } from 'zod'

declare const provider: LLMProvider
declare const model: string
declare const prompt: string
declare const schema: z.ZodTypeAny

// The front door can ask for a schema, and hands the parsed value back.
const { structuredOutput } = await runAgent({
  provider, model, prompt,
  structuredOutput: { schema },
})
```

- `BaseAgentResult.structuredOutput` — so an archetype's `run()` returns the object, not only text.
- **Both delegation surfaces** — `Agent` and `create_task` return a schema-configured child's *object* to the parent, rather than the prose beside it. A supervisor fanning out to specialists gets typed answers instead of strings its model has to re-parse.
- `run.json` persists it, so a run fetched by id still carries its answer.

A child with no schema is unchanged: its prose is still what the parent receives.

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
import type { ToolResult } from '@namzu/sdk'

declare const base64Png: string

const result: ToolResult = {
  success: true,
  output: 'Screenshot captured (1920x1080, image/png).',
  content: [
    { type: 'text', text: 'Screenshot captured.' },
    { type: 'image', data: base64Png, mediaType: 'image/png' },
  ],
}
```

The two channels are separate on purpose: a host UI wants the description, the
model wants the pixels. Driver capabilities distinguish user-message images
from image tool results. The account-routed Responses transport and other
drivers with `supportsToolResultImages: true` send the actual image block;
text-only result wires degrade to an explicit `[image: …]` placeholder rather
than dumping base64 into the conversation. The runtime warns before such a
degraded request, or refuses it when strict capability mode is enabled.

Failed results are marked on the wire as well — `is_error` on Anthropic, `status: 'error'` on Bedrock — so the model's tool-failure recovery behavior fires instead of relying on prose formatting.

## 7b. Deadlines and Output Budgets

Two runtime bounds apply to every tool, with no configuration required.

**Deadline.** Tools get 120 seconds by default (`toolTimeoutMs` on `query()`, or `timeoutMs` per tool). On expiry the executor stops waiting and returns a model-visible error result, so the agent can route around a slow dependency instead of losing the turn. `context.abortSignal` fires at the same moment, so a cooperative tool actually stops working — `bash` passes it to the child process.

A tool that legitimately runs longer declares its own `timeoutMs`, and the ones that need to already do: `bash` declares a deadline above the ten-minute ceiling its own input accepts, and `create_task` — which runs an entire agent — declares an hour. A tool that runs long without declaring anything inherits the 120-second default, which is how a delegated child that finished in eight minutes was reported to its parent as an abandoned tool at two.

The blocking `Agent` delegation tool owns its child through this same signal.
If the launching run is stopped while task creation is still pending, the
eventual task is cancelled as soon as its handle exists; if the task is already
running, it is cancelled immediately. Built-in local and foreign-delegate
schedulers preserve the structured `parent` cause on the child's abort signal.
This does not change `create_task`: that operation intentionally returns a
background handle and is governed by its separate task lifecycle.

**A cancellation says what stopped it.** If the host aborted with a reason, that reason reaches the tool result:

```
Tool "bash" was cancelled: run budget exhausted
```

A cancellation and a deadline arrive by the same mechanism and mean opposite things to whoever reads the result. "Was cancelled" tells a model that something outside it decided and nothing about what — so an operator pressing stop, a budget running out, and a parent abandoning a child were all reported identically, and every one of those wants a different next move.

Two kinds of reason are deliberately reported as *no* reason, so today's honest silence is not replaced by a fake explanation: a bare `abort()` fills `reason` with a platform `AbortError`, which is nobody's message, and a non-`Error` reason is dropped rather than rendered (a bare string `'canceled'` would read as `was cancelled: canceled`). Pass an `Error` with a sentence in it if you want the model to see one.

**Output budget.** A single tool result is capped at 40,000 model-visible characters (`maxToolOutputChars`; `0` disables). The cap includes the executor's omission/recovery text and any `post_tool_use` replacement; those additions cannot silently exceed the configured limit. Over-budget output is written to `<runDir>/tool-output/<toolUseId>.txt` and replaced with a head+tail preview naming the path, so nothing is lost and tokens are paid only if the agent decides the rest is worth re-reading — with `read` and `grep`, tools it already has.

Executor-owned calls also receive the resolved value as
`ToolContext.maxToolOutputChars`. A tool that has a native continuation
protocol can therefore page before the generic head+tail fallback discards its
middle. Direct host calls may omit the field; a tool must preserve its existing
unbounded direct-call behavior in that case unless the host says otherwise.

`SkillTool` uses that native path for both operations: omit `name` to page the
model-invocable metadata catalog, or provide `name` to page the exact skill
body. Catalog pages never substitute the registry's raw name list because that
list may include operator-only skills. Both cursor forms bind the state that
makes their continuation truthful; a metadata, policy, body, or active-cap
change is a stale-cursor refusal rather than a mixed snapshot.

Relatedly, `read` returns the first 2000 lines when given no window, and says so with a `[PARTIAL view — lines X-Y of Z]` notice naming the exact next call. A truncated read that looks like a short file is the most expensive silent failure a read tool can have.

## 7c. Failing and Recovering

**Retryable failures.** A tool may declare `maxRetries` and mark a result
`retryable: true`, and the executor will re-run it in-loop instead of
sending the error back for the model to re-decide.

```ts sketch
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

Attempts are spaced by an exponential backoff with full jitter, defaulting to
500ms doubling to a 16s ceiling. Tune it per run with
`query({ toolRetryBackoff })`, or set `initialDelayMs: 0` to retry
immediately.

**Repairing a malformed call.** `query({ repairToolCall })` gets a last
look before the error reaches the model, and may rewrite the arguments and
the tool name.

## 7c-bis. Making a Malformed Call Impossible

§7c repairs a call whose arguments do not match the schema. Some
endpoints can make that unnecessary: they constrain decoding to the
schema, so invalid arguments cannot be emitted at all.

It is opted into per TOOL, not per provider — the tool's author is the one
who knows whether closing its schema is safe:

```ts
import { defineTool } from '@namzu/sdk'
import { z } from 'zod'

const deploy = defineTool({
  name: 'deploy',
  description: 'Deploy a build to an environment.',
  inputSchema: z.object({ environment: z.string() }),
  category: 'shell',
  permissions: [],
  readOnly: false,
  destructive: true,
  concurrencySafe: false,
  // The opt-in. Everything above is what any tool declares.
  enforceModelInput: true,
  async execute({ environment }) {
    return { success: true, output: `deployed to ${environment}` }
  },
})
```

The kernel collects the enforced names per request and passes them to the
driver as `ChatCompletionParams.enforceToolInputSchema`; a driver that
supports constrained decoding maps them onto its own wire (OpenAI takes
`strict: true` on the function). Nothing is set on the provider itself.

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

```ts sketch
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
- `AuthorizationGate` can allow, deny, or review a tool call
- sandbox-aware tools can execute inside a constrained environment
- destructive flags can feed HITL or other policy layers

Read [Tool Safety](./safety.md) for the full decision path.

## Related

- [Built-In Tools](./built-in.md)
- [Connectors and MCP](../integrations/connectors-and-mcp.md)
- [Tool Safety](./safety.md)
- [defineTool Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/tools/defineTool.ts)
- [ToolRegistry Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/registry/tool/execute.ts)
