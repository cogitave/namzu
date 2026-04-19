---
title: Event Bridges
description: Bridge internal Namzu runtime events to SSE and A2A wire formats, and convert messages, runs, and agent metadata into protocol-friendly shapes.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk"]
---

# Event Bridges

Namzu's runtime emits internal domain events and messages, but published apps often need wire-friendly shapes. The bridge helpers are the translation layer between those internal runtime types and external protocols such as SSE and A2A.

## 1. Why the Bridge Layer Exists

The SDK exports both:

- internal domain types under `types/`
- wire-facing contracts under `contracts/`

The bridge helpers keep those worlds explicit instead of forcing your app to manually rewrite every event and message shape.

## 2. SSE Mapping With `mapRunToStreamEvent()`

`mapRunToStreamEvent(event, runId)` turns selected `RunEvent` values into SSE-friendly wire events:

```ts
import {
  query,
  autoApproveHandler,
  mapRunToStreamEvent,
  generateProjectId,
  generateSessionId,
  generateTenantId,
} from '@namzu/sdk'

const iterator = query({
  provider,
  tools,
  agentId: 'docs-streaming-agent',
  agentName: 'Docs Streaming Agent',
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

  const mapped = mapRunToStreamEvent(next.value, next.value.runId)
  if (mapped) {
    console.log(mapped.wire, mapped.data)
  }
}
```

Typical mapped wire events include:

- `run.started`
- `iteration.started`
- `message.delta`
- `tool.executing`
- `tool.completed`
- `review.requested`
- `checkpoint.created`

## 3. Important SSE Limitation

Not every `RunEvent` maps to an SSE event, and the final completion does not come from the mapper.

Key rule:

- use `mapRunToStreamEvent()` for incremental wire events
- use the final `AgentRun` from `drainQuery()` or generator completion for the terminal result

This matters because `run_completed` and `run_failed` are not emitted as mapped SSE payloads today.

## 4. A2A Message Conversion

The message bridge helpers translate between Namzu messages and A2A messages:

```ts
import {
  messageToA2A,
  a2aMessageToInput,
  extractTextFromA2AMessage,
} from '@namzu/sdk'

const a2aMessage = messageToA2A({
  role: 'user',
  content: 'Summarize the workspace.',
})

console.log(a2aMessage)
console.log(a2aMessageToInput(a2aMessage))
console.log(extractTextFromA2AMessage(a2aMessage))
```

Practical behavior:

- `user` stays `user`
- `assistant`, `system`, and `tool` become A2A role `agent`
- tool calls are encoded as `data` parts with Namzu-specific MIME types

## 5. Convert a Run Into an A2A Task

`runToA2ATask()` turns a wire-contract `Run` plus optional message history into an A2A task object:

```ts
import { runToA2ATask } from '@namzu/sdk'

const a2aTask = runToA2ATask(run, history)
console.log(a2aTask.status.state)
console.log(a2aTask.artifacts)
```

This is useful when:

- a Namzu run should be exposed to an A2A client
- your app already stores or serves `Run` contract payloads
- you need task history and final artifacts in A2A-compatible form

## 6. Convert Inbound A2A Messages Into Namzu Run Inputs

`a2aMessageToCreateRun()` is the inbound half of the bridge:

```ts
import { a2aMessageToCreateRun } from '@namzu/sdk'

const createRun = a2aMessageToCreateRun('research-agent', {
  contextId: 'thread_123',
  message: {
    role: 'user',
    parts: [{ kind: 'text', text: 'Find the project summary.' }],
  },
  metadata: {
    model: 'gpt-4o-mini',
    tokenBudget: 16_384,
    timeoutMs: 120_000,
    permissionMode: 'plan',
  },
})

console.log(createRun.input)
console.log(createRun.config)
```

This helper extracts text input and preserves selected runtime config values from the inbound A2A metadata envelope.

## 7. Build an A2A Agent Card

`buildAgentCard()` creates the capability card an A2A client can consume:

```ts
import { buildAgentCard } from '@namzu/sdk'

const card = buildAgentCard(
  {
    id: 'docs-agent',
    name: 'Docs Agent',
    description: 'Answers repository documentation questions.',
    version: '1.0.0',
    tools: ['read_file', 'grep'],
    capabilities: {
      supportsStreaming: true,
    },
  },
  {
    baseUrl: 'https://docs.example.com',
    transport: 'rest',
    providerOrganization: 'Namzu',
  },
)

console.log(card)
```

The helper converts tool names and optional skills into A2A `skills` entries and sets the supported interface URL automatically from the supplied config.

## 8. Map Live Runtime Events to A2A Stream Events

`mapRunToA2AEvent()` maps selected `RunEvent` values into `TaskStatusUpdateEvent` or `TaskArtifactUpdateEvent` payloads:

```ts
import { mapRunToA2AEvent } from '@namzu/sdk'

const mapped = mapRunToA2AEvent(event, 'ctx_123')
if (mapped) {
  console.log(mapped)
}
```

Important runtime choices baked into the mapper:

- `run_started` maps to task state `running`
- `run_completed` maps to final task state `completed`
- `run_failed` maps to final task state `failed`
- `tool_review_requested`, `plan_ready`, and `run_paused` map to `input-required`
- many internal events intentionally map to `null`

That makes the A2A stream cleaner than the full internal event bus.

## 9. State Helpers

The A2A helpers also export two small but useful state functions:

- `runStatusToA2AState()`
- `isTerminalState()`

Use them when your app needs to reason about status transitions without rebuilding the mapping table yourself.

## 10. Choosing the Right Bridge

| If you need... | Use |
| --- | --- |
| Browser- or app-friendly incremental run events | `mapRunToStreamEvent()` |
| A2A task lifecycle streaming | `mapRunToA2AEvent()` |
| A2A task snapshots from stored runs | `runToA2ATask()` |
| A2A agent discovery metadata | `buildAgentCard()` |
| Inbound A2A message parsing | `a2aMessageToCreateRun()` and `a2aMessageToInput()` |

## 11. Common Mistakes

| Mistake | Why it hurts |
| --- | --- |
| expecting every internal `RunEvent` to map to SSE or A2A | the bridge intentionally drops some internal-only events |
| treating mapped SSE output as the final run result channel | final completion still comes from the returned `AgentRun` or stored `Run` |
| manually rewriting message role conversions | the bridge already encodes Namzu-to-A2A role semantics consistently |

## Related

- [Low-Level Runtime](../runtime/low-level.md)
- [SDK Runtime](../runtime/README.md)
- [Telemetry](../observability/README.md)
- [Integration Folders](../architecture/integration-folders.md)
- [A2A Bridge Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/bridge/a2a/index.ts)
- [SSE Bridge Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/bridge/sse/index.ts)
