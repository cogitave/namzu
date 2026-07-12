---
title: Low-Level Runtime
description: Use query() and drainQuery() directly in @namzu/sdk when you need verification gates, sandbox providers, plugin wiring, event streaming, or query-only runtime controls.
last_updated: 2026-07-13
status: current
related_packages: ["@namzu/sdk", "@namzu/openai"]
---

# Low-Level Runtime

`ReactiveAgent.run()` is the best default for most users, but it is intentionally not the entire kernel surface. The lower-level runtime entrypoints are `query()` and `drainQuery()`. Use them when you need features that live below the high-level agent wrappers.

## 1. When to Drop Below `ReactiveAgent`

Use the low-level runtime when you need:

- `verificationGate` policy before tool execution
- a `sandboxProvider` that injects a real sandbox into tool context
- direct `RunEvent` streaming
- plugin manager, task router, agent bus, or compaction wiring
- custom resume-handler behavior for HITL review or checkpoints

If you only need messages, tools, provider, IDs, and a final result, stay with `ReactiveAgent.run()`.

## 2. `ReactiveAgent.run()` vs `drainQuery()`

| Surface | Best for | Notable limits |
| --- | --- | --- |
| `ReactiveAgent.run()` | Standard app integrations and quickstarts | Does not expose query-only runtime fields such as `verificationGate` or `sandboxProvider` |
| `drainQuery()` | Low-level runtime control with a final `AgentRun` result | You supply more runtime wiring yourself |
| `query()` | Full async-generator control over every emitted event | You manage iteration over the generator directly |

## 3. Minimal `drainQuery()` Example

```ts
import {
  ProviderRegistry,
  ToolRegistry,
  ReadFileTool,
  LocalSandboxProvider,
  drainQuery,
  autoApproveHandler,
  generateProjectId,
  generateSessionId,
  generateTenantId,
  getRootLogger,
} from '@namzu/sdk'
import { registerOpenAI } from '@namzu/openai'

registerOpenAI()

const { provider } = ProviderRegistry.create({
  type: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o-mini',
})

const tools = new ToolRegistry()
tools.register(ReadFileTool)

const sandboxProvider = new LocalSandboxProvider(getRootLogger())

const run = await drainQuery(
  {
    provider,
    tools,
    agentId: 'docs-kernel-agent',
    agentName: 'Docs Kernel Agent',
    messages: [
      {
        role: 'user',
        content: 'Read package.json and tell me the package name.',
      },
    ],
    workingDirectory: process.cwd(),
    runConfig: {
      model: 'gpt-4o-mini',
      tokenBudget: 8_192,
      timeoutMs: 60_000,
      permissionMode: 'plan',
    },
    projectId: generateProjectId(),
    sessionId: generateSessionId(),
    tenantId: generateTenantId(),
    resumeHandler: autoApproveHandler,
    verificationGate: {
      enabled: true,
      allowReadOnlyTools: true,
      denyDangerousPatterns: true,
      rules: [{ type: 'allow_by_category', categories: ['filesystem'] }],
    },
    sandboxProvider,
  },
  async (event) => {
    console.log(event.type)
  },
)

console.log(run.result)
```

This example shows the main low-level boundary:

- `runConfig` still carries model, budget, and permission settings
- query-only fields such as `verificationGate` and `sandboxProvider` live beside that config
- `drainQuery()` still returns the same final `AgentRun` shape that high-level agent flows assemble

## 4. What `drainQuery()` Gives You

`drainQuery()` is the convenience wrapper around `query()`:

- it consumes the async generator for you
- it forwards every `RunEvent` to an optional listener
- it returns the final `AgentRun`
- it falls back to `autoApproveHandler` if you omit `resumeHandler`

That makes it the best low-level entrypoint when you still want one final result object.

**`query()` and `drainQuery()` default differently, and the difference matters.**
`query()` with no `resumeHandler` falls back to `deferredReviewHandler`, which
**parks the run durably** on a tool review rather than approving it — an absent
handler must not mean "I authorized this batch". `drainQuery()` keeps its
historical `autoApproveHandler` default, because flipping it would silently turn
every existing caller's run into one that waits forever for a decision nobody is
coming to make.

To get a durable pause out of `drainQuery()`, ask for one:

```ts
import { drainQuery, deferredReviewHandler } from '@namzu/sdk'

const run = await drainQuery({ resumeHandler: deferredReviewHandler, /* ... */ })
// run.status === 'awaiting_input' if it parked — see Durable Pause
```

## 5. Use `query()` for Generator-Level Control

If you need full control over the event stream, use `query()` directly:

```ts
import {
  query,
  mapRunToStreamEvent,
  autoApproveHandler,
  generateProjectId,
  generateSessionId,
  generateTenantId,
} from '@namzu/sdk'

const iterator = query({
  provider,
  tools,
  agentId: 'docs-kernel-agent',
  agentName: 'Docs Kernel Agent',
  messages: [{ role: 'user', content: 'Say hello.' }],
  workingDirectory: process.cwd(),
  runConfig: {
    model: 'gpt-4o-mini',
    tokenBudget: 8_192,
    timeoutMs: 60_000,
  },
  projectId: generateProjectId(),
  sessionId: generateSessionId(),
  tenantId: generateTenantId(),
  resumeHandler: autoApproveHandler,
})

while (true) {
  const next = await iterator.next()

  if (next.done) {
    console.log(next.value.result)
    break
  }

  const event = next.value
  const mapped = mapRunToStreamEvent(event)
  if (mapped) {
    console.log(mapped.wire, mapped.data)
  }
}
```

Use this pattern when a transport layer or UI needs every incremental event as it happens.

## 6. Query-Only Fields You Do Not Get Through `ReactiveAgent.run()`

`QueryParams` exposes extra runtime controls that are not currently surfaced on `ReactiveAgentConfig`:

| Field | Purpose |
| --- | --- |
| `verificationGate` | Rule-based allow, deny, or review decisions — evaluated before human review and again against the final input immediately before dispatch |
| `sandboxProvider` | Create a sandbox for the run and inject it into tool context |
| `pluginManager` | Run plugin hooks and plugin-contributed runtime behavior |
| `taskRouter` | Task-specific model routing |
| `agentBus` | Concurrency coordination and lock-style runtime controls |
| `compactionConfig` | Working-state compaction and message compression policy |
| `contextCache` | Prompt cache and context reuse controls |
| `resumeFromCheckpoint` | Continue **this** run from a checkpoint. Refuses a terminal run; see [Durable Pause](./durable-pause.md) |
| `replayOf` | Fork provenance. Build it with `prepareForkState()`, which also mints the new run id |
| `lease` | Tune the run lease (TTL, heartbeat, holder id). It **cannot be switched off** — one run is driven by one segment at a time |

That is the main reason this page exists: these are real public runtime features, but they are lower-level than the first-run agent API.

## 7. Resume Handlers and HITL

Low-level runtime control is also where human-in-the-loop policy becomes explicit.

```ts
const resumeHandler = async (request) => {
  switch (request.type) {
    case 'plan_approval':
      return { action: 'approve_plan' }
    case 'tool_review':
      return { action: 'approve_tools' }
    case 'iteration_checkpoint':
      return { action: 'continue' }
  }
}
```

Use `autoApproveHandler` only when the runtime should continue automatically.

A handler answers **in-process, while the run waits**. That is the fast path and
it is unchanged. It is the right shape when a reviewer can answer in seconds.

It is the wrong shape when the reviewer is a human who may take an hour, because
the run holds a live process for the whole wait (and that wait counts against
`timeoutMs`, which measures active execution time). For that, answer
`{ action: 'pause', reason }` from any handler — or pass no handler to `query()`
at all. The run **parks durably**: the question is persisted, the generator
returns, and the decision is answered out of process later against a single-use
resume token. See [Durable Pause](./durable-pause.md).

## 8. Verification and Sandbox Boundaries

Two low-level runtime fields are easy to confuse:

| Field | Role |
| --- | --- |
| `verificationGate` | Decide whether a tool call should proceed |
| `sandboxProvider` | Constrain what sandbox-aware tools can do if the call proceeds |

This separation matters operationally:

- verification is policy
- sandboxing is containment

Both are lower-level runtime concerns, which is why they are wired through `query()` and `drainQuery()` instead of `defineTool()` alone.

## 9. Event Streaming and SSE Mapping

`query()` and `drainQuery()` emit normalized `RunEvent` values. If you need a wire-friendly event shape, use `mapRunToStreamEvent(event)`.

It takes **one argument** as of `0.5.0`. The second argument used to overwrite
`event.runId`, and it existed only because the API and the SDK minted different
ids for one run. They do not anymore — see
[Migrating to 0.5.0 §H](../../migration/0.5.md#section-h--one-canonical-run-id).

Important nuance:

- many incremental runtime events map cleanly to wire events
- final completion still comes from the async generator return value or the `drainQuery()` result

That means stream transport code usually needs both:

1. mapped incremental events during execution
2. the final `AgentRun` when execution completes

A run that **parks** for a decision also returns from the generator — with
`status: 'awaiting_input'`, not a completion. Do not read a returned `AgentRun`
as "finished" without checking its status.

## 10. Common Mistakes

| Mistake | Why it breaks |
| --- | --- |
| assuming `ReactiveAgent.run()` exposes every runtime field | query-only controls such as `verificationGate` and `sandboxProvider` are lower-level |
| omitting `resumeHandler` on `query()` and expecting it to auto-approve | it does not. `query()` falls back to `deferredReviewHandler` and a tool review **parks the run**. `drainQuery()` is the one that auto-approves |
| passing `mapRunToStreamEvent(event, runId)` | it takes one argument now. The second one existed only to paper over two ids for one run |
| skipping `workingDirectory` | filesystem tools and path layout lose their stable base path |
| treating `mapRunToStreamEvent()` as the final result channel | completion still comes from generator completion or `drainQuery()` |
| treating a returned `AgentRun` as finished | a parked run returns too, with `status: 'awaiting_input'` |

## Related

- [SDK Quickstart](../quickstart.md)
- [Run Configuration](./configuration.md)
- [Durable Pause](./durable-pause.md)
- [Tool Safety](../tools/safety.md)
- [Connectors and MCP](../integrations/connectors-and-mcp.md)
- [Plugins and MCP Servers](../integrations/plugins.md)
- [Event Bridges](../integrations/event-bridges.md)
- [Query Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/runtime/query/index.ts)
- [Run Event Types](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/types/run/events.ts)
