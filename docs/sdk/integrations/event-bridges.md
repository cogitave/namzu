---
title: Event Bridges
description: Bridge internal Namzu runtime events to SSE and A2A wire formats, and convert messages, runs, and agent metadata into protocol-friendly shapes.
last_updated: 2026-08-06
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
- `compaction.completed`
- `compaction.failed`
- `plan.ready`, `plan.approved`, `plan.rejected`, `plan.step_updated`,
  `plan.completed`, `plan.failed`

> **`plan.completed` and `plan.failed` are new in `@namzu/sdk` 12.0.0.** They
> were folded into a bare `break` in the translator and emitted nothing, so a
> host watching the stream saw a plan's steps report and then silence — it
> could learn a plan had been approved and never that it closed, which leaves
> a plan rendered as in-flight indefinitely. `StreamEventType` is wider as a
> result; a consumer that switches exhaustively over it needs the two new
> arms. `plan.failed` carries a `reason`. See
> [Plans and Step Reporting](../runtime/plans.md).

The two compaction events are both worth forwarding to a UI, and the second is
the one that is easy to leave out. A compaction pass that shed **nothing** is
exactly as consequential as one that did: the run continues at full context
toward a provider rejection several turns later that will name none of this.
`compaction.failed` carries a `cause` saying which of the three declines
happened — see [Loop Control](../runtime/loop-control.md).

`token.usage` carries `context_tokens` and `context_window_tokens` alongside the
cumulative `usage`, each with its provenance (`context_measured_by`,
`window_source`). **Build a context-fullness indicator from `context_tokens`,
never from `usage`** — the latter is cumulative spend across every turn and is
untouched by compaction, so dividing it by a window yields a gauge that climbs
toward full on any long run regardless of how much room the conversation has. A
remote surface has exactly the same opportunity to make that mistake as a local
one and no more information with which to notice it, which is why both numbers
are named apart on the wire as well as in the type.

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
    tools: ['Read', 'Grep'],
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
- `run_failed` maps to final task state `failed`, carrying the failure's
  `code` / `retryable` / `details` as event **metadata** rather than folded
  into the text — a peer deciding whether to retry needs the flag, not prose
  it would have to pattern-match
- `provider_retry` maps to `running`, because a backoff is a task still
  working, not a failure
- `tool_review_requested`, `plan_ready`, and `run_paused` map to `input-required`
- **only `plan_ready` crosses of the six plan events.** `plan_approved`,
  `plan_rejected`, `plan_step_updated`, `plan_completed`, and `plan_failed`
  map to `null` here while all six are forwarded on SSE — same reasoning as
  the compaction events: a peer models a task lifecycle, and how this runtime
  gates and settles its own plan is not something the peer can act on
- **neither compaction event is forwarded.** A peer models a task lifecycle and
  cannot act on how this runtime manages its own context — the loss is real, but
  it is this runtime's business rather than the peer's. On SSE, where the
  consumer is a UI attached to this run, both are forwarded.
- many internal events intentionally map to `null`

### Knowing a run is backing off, not hung

`provider_retry` is emitted **before** each backoff sleep, so the delay it
names is still ahead. With the default policy — three retries, a 16s cap —
or a server-directed `Retry-After` up to the 60s ceiling, a run can
otherwise sit silent for the better part of a minute between
`iteration_started` and the next event. A host saw nothing and got no
keepalive, so a backoff was indistinguishable from a hang and a watchdog
would cancel a run that was about to succeed.

It carries the attempt, the ceiling, the delay, the classified code and
whether the delay was the server's idea. On the SSE wire it is
`provider.retry`.

### Reading why a run failed

`run_failed` carries three things:

- `error` — the flattened message, for consumers that only render a string
- `failure` — the structured projection: `code`, `retryable`, and `details`
  including the provider code, status and any `retryAfterMs`
- `explanation` — an operator-facing `{ id, message, hint }`, when a
  catalog rule claims the failure

The classification is computed at the provider boundary — over status,
errno, `Retry-After` and the whole cause chain — and used to be discarded
one line before the event was emitted, leaving a host to guess whether
"request failed" meant a rate limit worth retrying or a bad key worth
stopping for.

`explanation` is a separate layer on purpose: classification is structural
and belongs at the boundary, remediation is editorial and belongs in a list
a human appends to. Its `id` is stable and greppable; `hint` says what to
change. It is **absent** when no rule matched — inventing advice for an
uncharacterised failure is worse than saying nothing, because it sends the
reader somewhere specific and wrong. Extend it by passing your own rules to
`explainError(err, rules)`, or attach a hint at the raise point with
`withHint(err, '…')`, which outranks every generic rule because code that
raised a failure knows more about it than a status code does.

### A run that paused instead of failing

A transient failure that survived every in-turn recovery now settles as
**paused** rather than failed, emitting `run_paused` with the checkpoint to
resume from. A 503 and a bad API key used to be indistinguishable at the
run boundary, and recovering meant the host knowing about checkpoints and
driving replay itself.

Two conditions, both required: the failure must classify as `retryable`,
and a checkpoint must exist. Pausing on a permanent error would invite a
resume that cannot work, and pausing with nowhere to resume from produces a
run nobody can ever pick up — strictly worse than reporting the failure.

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
