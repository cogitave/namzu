---
title: Event Bridges
description: Bridge internal Namzu runtime events to SSE and A2A wire formats, and convert messages, runs, and agent metadata into protocol-friendly shapes.
type: Guide
status: stable
tags: [sdk]
generated: { by: human:bahadirarda, at: 2026-08-24T00:00:00Z }
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
  generateTopicId,
  type LLMProvider,
  type ToolRegistryContract,
} from '@namzu/sdk'

declare const provider: LLMProvider
declare const tools: ToolRegistryContract

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
  tenantId: generateTenantId(),
  projectId: generateProjectId(),
  topicId: generateTopicId(),
  sessionId: generateSessionId(),
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

All four scope ids are **required**, not four of a set you pick from: every run
is attributed to the full Tenant → Project → Topic → Session → Run hierarchy,
and `topicId` is denormalized from `session.topicId` so the query pipeline
never needs a second `SessionStore` round-trip to recover it. Omit any one and
the call does not typecheck.

### The cursor a client reconnects at

**New in `@namzu/sdk` 21.0.0.** A mapped event carries `id` — `"<runId>:<seq>"`
— whenever the underlying event is in the run's durable log. It sits beside the
payload rather than inside `data` because that is what an SSE `id:` line
should carry, and a framer writes it without having to know what kind of event
it is:

```ts
import type { MappedStreamEvent } from '@namzu/sdk'
import type { ServerResponse } from 'node:http'

declare const mapped: MappedStreamEvent
declare const res: ServerResponse

if (mapped.id) res.write(`id: ${mapped.id}\n`)
res.write(`event: ${mapped.wire}\ndata: ${JSON.stringify(mapped.data)}\n\n`)
```

`id` is **absent** on every event that is not recoverable, and three different
things arrive that way:

- the ephemeral ones — `message.delta`, `tool.input_delta`, `reasoning.delta`
  and `tool.progress` — which are deliberately never persisted;
- any event whose durable write failed. It still reaches the live stream,
  unstamped, because losing the news of a failure is worse than delivering it
  without a cursor;
- the delegation lifecycle events — `agent.pending`, `agent.completed`,
  `agent.failed`, `agent.canceled` — which the agent manager hands straight to
  a host's listener without passing through the run's event translator. They
  are in no run's log at all, so this absence is structural rather than a
  transient write failure, and no retry or reconnect will produce one.

A client must not advance its cursor onto any of them.

`tool.progress` is a bounded latest-state signal, not a lossless output log.
Each message is at most 8 KiB of UTF-8; when a live consumer is slower than the
tool, intermediate pending updates are replaced by the newest one. Every update
the executor accepted settles before that call's `tool.completed` event. Put
complete output in the tool result and recover it from the durable terminal
event; reconnect never replays progress.

It is keyed on the event's **own** run, not on the stream it arrives on. A
parent's stream carries its children's events and each run numbers its own log,
so one scalar over a mixed stream would compare positions from two different
sequences — and would look right. Keep one cursor per run id and send the right
one back. See Replay §7.

Typical mapped wire events include:

- `run.started`
- `iteration.started`
- `message.delta`
- `tool.executing`
- `tool.completed`
- `review.requested`
- `checkpoint.created`
- `compaction.completed`
- `compaction.tool_results_cleared`
- `compaction.failed`
- `provider.retry`, `provider.fallback`
- `plan.ready`, `plan.approved`, `plan.rejected`, `plan.step_updated`,
  `plan.completed`, `plan.failed`

> **`plan.completed` and `plan.failed` are new in `@namzu/sdk` 12.0.0.** They
> were folded into a bare `break` in the translator and emitted nothing, so a
> host watching the stream saw a plan's steps report and then silence — it
> could learn a plan had been approved and never that it closed, which leaves
> a plan rendered as in-flight indefinitely. `StreamEventType` is wider as a
> result; a consumer that switches exhaustively over it needs the two new
> arms. `plan.failed` carries a `reason`. See
> Plans and Step Reporting.

**Three compaction events reach this wire, and the two easy to leave out are
the ones that say the most.** `compaction.tool_results_cleared` is the cheapest
and most common relief path — oversized `tool_result` bodies replaced in place —
and it edits the transcript irrecoverably, so a client that does not hear it
renders results the run no longer holds. Its `relief_was_enough: false` means a
summarization pass followed in the same iteration, and a reader who saw only the
`compaction.completed` would attribute the whole loss to it. A pass that shed
**nothing** is exactly as consequential as one that did: the run continues at
full context toward a provider rejection several turns later that will name none
of this. `compaction.failed` carries a `cause` saying which of the three declines
happened — `reducer_threw`, `shed_nothing` or `split_tool_pair`.

A fourth compaction event, `compaction_shed`, exists internally and is
deliberately **not** on this wire: it carries the whole message bodies the pass
removed, tool output included, and a subscribed browser must not receive a frame
carrying the content a compaction just deleted.

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
- use the final `Run` from `drainQuery()` or generator completion for the terminal result

That final value is the domain `Run` — the type `AgentRun` used to name. The
alias still resolves and is `@deprecated`; write `Run`.

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

`runToA2ATask()` turns a `WireRun` plus optional message history into an A2A task object:

```ts
import { runToA2ATask, type Message, type WireRun } from '@namzu/sdk'

declare const run: WireRun
declare const messages: readonly Message[]

const a2aTask = runToA2ATask(run, messages)
console.log(a2aTask.status.state)
console.log(a2aTask.artifacts)
```

The parameter is the **wire** run, `WireRun` from `contracts/`, not the domain
`Run` from `types/`. The two are different records that were once both called
`Run`, and they are not interchangeable: the wire one carries `snake_case`
fields (`agent_id`, `completed_at`, `duration_ms`) and a `WireRunStatus`, while
the domain one carries `camelCase` fields and the kernel's own execution
status. Pass the domain record and nothing typechecks; the mapper reads fields
it does not have.

The task's `contextId` is the run's `project_id` — **absent**, not an empty
string, when the run has no project, so a peer can tell "no context" from "a
context named nothing". `artifacts` is likewise `undefined` rather than `[]`
until the run has a `result`. See §6 for the inbound half of that binding.

This is useful when:

- a Namzu run should be exposed to an A2A client
- your app already stores or serves `WireRun` contract payloads
- you need task history and final artifacts in A2A-compatible form

## 6. Convert Inbound A2A Messages Into Namzu Run Inputs

`a2aMessageToCreateRun()` is the inbound half of the bridge:

```ts
import { a2aMessageToCreateRun } from '@namzu/sdk'

const createRun = a2aMessageToCreateRun('research-agent', {
  // A2A's contextId is a namzu **Project** id, in both directions.
  contextId: 'prj_research',
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
console.log(createRun.projectId)
console.log(createRun.config)
```

This helper extracts text input and preserves selected runtime config values from the inbound A2A metadata envelope: `model`, `temperature`, `tokenBudget`, `maxResponseTokens`, `timeoutMs`, `permissionMode` (`'plan'` or `'auto'` only) and `systemPrompt`. A key of the wrong type is dropped rather than coerced.

**The inbound `contextId` becomes `projectId`, not a thread or session id.** The
binding is `projectId: params.contextId` here and `contextId: run.project_id` in
`runToA2ATask()`, so a context a peer was handed is a context it can send back.
That matters beyond naming: everything scoped to a Project — delegation caps,
shared stores, retention, the on-disk root — is in scope for a peer holding the
context. See A2A Threading, which retracts the
older claim that A2A attached at the Thread level; no version of the bridge ever
referenced a Thread.

## 7. Build an A2A Agent Card

`buildAgentCard()` creates the capability card an A2A client can consume:

```ts
import { buildAgentCard, type AgentInfo, type A2AServerConfig } from '@namzu/sdk'

const info: AgentInfo = {
  id: 'docs-agent',
  name: 'Docs Agent',
  description: 'Answers repository documentation questions.',
  version: '1.0.0',
  category: 'documentation',
  tools: ['Read', 'Grep'],
  defaults: {
    model: 'gpt-4o-mini',
    tokenBudget: 8_192,
  },
  capabilities: {
    supportsTools: true,
    supportsStreaming: true,
    supportsConcurrency: false,
    supportsSubAgents: false,
  },
}

const config: A2AServerConfig = {
  baseUrl: 'https://docs.example.com',
  transport: 'rest',
  providerOrganization: 'Namzu',
}

const card = buildAgentCard(info, config)

console.log(card)
```

The helper converts tool names and optional skills into A2A `skills` entries and sets the supported interface URL automatically from the supplied config.

Two things about the input are easy to get wrong. `AgentInfo` is the full
contract record — `category` and `defaults` are required alongside the fields
the card visibly uses, and `capabilities` is all-or-nothing: `AgentCapabilities`
declares four booleans and none is optional, so you cannot supply
`supportsStreaming` alone. And of those four only `supportsStreaming` reaches
the card, as `capabilities.streaming`; `pushNotifications` and
`extendedAgentCard` are hard-coded `false`, and `supportsTools`,
`supportsConcurrency` and `supportsSubAgents` have no A2A counterpart the card
can carry. Declare them honestly anyway — the same `AgentInfo` is read
elsewhere.

Skills are the optional third parameter, `buildAgentCard(info, config, skills)`.
Each `Skill` becomes an A2A skill tagged `procedure`, beside the tool-derived
ones tagged `tool`.

## 8. Map Live Runtime Events to A2A Stream Events

`mapRunToA2AEvent()` maps selected `RunEvent` values into `TaskStatusUpdateEvent` or `TaskArtifactUpdateEvent` payloads:

```ts
import { mapRunToA2AEvent, type RunEvent } from '@namzu/sdk'

declare const event: RunEvent

// The contextId is a Project id — the same binding §6 describes.
const mapped = mapRunToA2AEvent(event, 'prj_research')
if (mapped) {
  console.log(mapped)
}
```

Important runtime choices baked into the mapper:

- **`tool_completed` is the only event that becomes a `TaskArtifactUpdateEvent`.**
  Everything else the mapper emits is a `TaskStatusUpdateEvent`, so a consumer
  branching on the two shapes is really branching on "was this a tool result".
  The artifact's `artifactId` is minted as `` `tool-${toolName}-${Date.now()}` ``
  — it is not stable across a replay, and it is not a key to store against
- `run_started` maps to task state `running`
- `run_completed` maps to final task state `completed`
- `run_failed` maps to final task state `failed`, carrying the failure's
  `code` / `retryable` / `details` as event **metadata** rather than folded
  into the text — a peer deciding whether to retry needs the flag, not prose
  it would have to pattern-match
- `provider_retry` maps to `running`, because a backoff is a task still
  working, not a failure
- `provider_fallback` maps to `running` too — the run did not fail, it moved.
  A peer that is not told has no way to know the answer it is reading came from
  a provider it did not ask for, at a different price and possibly a different
  quality
- `message_completed` maps to `running` carrying the aggregated assistant text;
  `message_started`, `text_delta` and the three `tool_input_*` events map to
  `null`, because A2A's status-update model is coarse-grained and a per-delta
  event has no representation in it
- **four events map to `input-required`, not three**: `tool_review_requested`,
  `user_question_asked`, `plan_ready` and `run_paused`. A client that renders an
  approval card off this state must handle a question and a pause as well.
  `user_question_answered` maps to `null` — the task leaves `input-required` on
  the next status event the resumed run emits, and a second one here would only
  restate it
- **only `plan_ready` crosses of the six plan events.** `plan_approved`,
  `plan_rejected`, `plan_step_updated`, `plan_completed`, and `plan_failed`
  map to `null` here while all six are forwarded on SSE — same reasoning as
  the compaction events: a peer models a task lifecycle, and how this runtime
  gates and settles its own plan is not something the peer can act on
- **no compaction event is forwarded** — all four of `compaction_shed`,
  `compaction_completed`, `compaction_tool_results_cleared` and
  `compaction_failed` map to `null`. A peer models a task lifecycle and cannot
  act on how this runtime manages its own context — the loss is real, but it is
  this runtime's business rather than the peer's. On SSE, where the consumer is
  a UI attached to this run, three of the four are forwarded; `compaction_shed`
  is declined there too, for the disclosure reason given in §2.
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

`run_failed` carries four things:

- `error` — the flattened message, for consumers that only render a string
- `failure` — the structured projection: `code`, `retryable`, and `details`
  including the provider code, status and any `retryAfterMs`
- `providerError` — the driver's own first-hand classification, when it
  produced one. Carried beside `failure` rather than folded into it, so a
  consumer deciding whether to retry can read what the provider actually said
- `explanation` — an operator-facing `{ id, message, hint }`, when a
  catalog rule claims the failure

Of the four, only `failure` is projected onto the A2A wire, as the status
event's `metadata`.

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

`run_paused` carries the same optional `failure`, `providerError` and
`explanation` values as `run_failed`, beside `checkpointId` and `reason`. A pause
is a different verdict, not a less informative one: retryability and
`retryAfterMs` are the facts a host needs to schedule recovery. The SSE
`run.paused` projection keeps all three structured values; A2A keeps the
checkpoint plus `failure` classification as status metadata, matching its
`run_failed` projection while retaining the address needed to recover.

Both provider error generations reach this path. Current drivers throw the
structural `ProviderRequestError` shape while older/custom providers may throw
`ProviderError`; terminal projection runs both through the same provider
taxonomy. A first-hand throttle therefore remains `provider_error` /
`rate_limit`, retryable, and retains status and retry delay instead of becoming
`unknown` at the run boundary.

That makes the A2A stream cleaner than the full internal event bus.

## 9. State Helpers

The A2A helpers also export two small but useful state functions:

- `runStatusToA2AState(status: WireRunStatus): A2ATaskState`
- `isTerminalState(state: A2ATaskState): boolean`

Use them when your app needs to reason about status transitions without rebuilding the mapping table yourself. `runStatusToA2AState()` takes the **wire** status, the same asymmetry §5 describes: the domain `RunStatus` is a wider state machine that collapses onto `WireRunStatus` first.

These are the tables both read:

```ts verbatim
// from: packages/sdk/src/constants/a2a/index.ts
export const A2A_PROTOCOL_VERSION = '0.3.0'

export const RUN_STATUS_TO_A2A: Record<WireRunStatus, A2ATaskState> = {
	queued: 'pending',
	running: 'running',
	completed: 'completed',
	failed: 'failed',
	cancelled: 'canceled',
	cancelling: 'running',
	expired: 'failed',
}

export const TERMINAL_STATES: ReadonlySet<A2ATaskState> = new Set([
	'completed',
	'failed',
	'canceled',
	'rejected',
])
```

Three things a peer-facing surface has to plan for. `cancelling` reports as
`running`, so a cancellation in flight is indistinguishable from ordinary work
until it settles. `expired` — an approval window that closed with nobody
answering — arrives as `failed`, carrying no signal that a human, rather than
the system, is what was missing. And `rejected` is terminal for a task but has
no `WireRunStatus` that produces it, so `isTerminalState()` accepts a state this
mapping never emits.

`A2A_PROTOCOL_VERSION` is the same constant `buildAgentCard()` stamps as the
card's `protocolVersion` in §7.

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
| treating mapped SSE output as the final run result channel | final completion still comes from the returned domain `Run` or the stored `WireRun` |
| manually rewriting message role conversions | the bridge already encodes Namzu-to-A2A role semantics consistently |

## Related

- [A2A Bridge Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/bridge/a2a/index.ts)
- [SSE Bridge Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/bridge/sse/index.ts)
