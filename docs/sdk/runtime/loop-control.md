---
title: Loop Control and Resilience
description: Stop conditions, step records, provider retry, budgets across resume, compaction triggers, and extended thinking in the @namzu/sdk agent loop.
last_updated: 2026-07-31
status: current
related_packages: ["@namzu/sdk", "@namzu/anthropic"]
---

# Loop Control and Resilience

`query()` runs the agent loop. This page covers the seams for controlling
when it stops, seeing what it did, and surviving the things that go wrong.

## 1. Stopping the Loop

The loop ends naturally when the model stops calling tools. Everything
else is a policy you supply.

### Programmable stop conditions

```ts
import { query, hasToolCall, stepCountIs, anyOf } from '@namzu/sdk'

query({
  // …
  stopWhen: anyOf(hasToolCall('submit_answer'), stepCountIs(20)),
})
```

`stopWhen` is evaluated **after** each step's tools have run, so a
predicate sees what they returned. That ordering is what lets a terminal
tool end the run *after* executing rather than instead of executing — its
output is still recorded and still reaches the model's history.

| Helper | Fires when |
| --- | --- |
| `stepCountIs(n)` | `n` steps have completed |
| `hasToolCall(...names)` | the latest step called any of `names` |
| `anyOf(...conditions)` | any condition fires (short-circuits) |

Conditions may be async. A condition that throws is logged and treated as
"do not stop" — a caller's bad predicate must not be able to kill a run
the real budgets would have let finish.

The run settles with `stopReason: 'stop_condition'`.

### Numeric budgets

`AgentRunConfig` carries `tokenBudget`, `costLimitUsd`, `timeoutMs` and
`maxIterations`. These are the backstop, not the primary control: they
answer "this has gone on too long", never "the work is done".

`costLimitUsd` requires a `pricing` table on `query()`. Without one, cost
stays at zero and the limit never trips.

## 2. Seeing What the Loop Did

`Run.steps` carries one `StepResult` per iteration, and `onStepFinish`
fires as each completes.

```ts
query({
  // …
  onStepFinish: (step) => {
    console.log(step.stepNumber, step.usage.totalTokens, step.durationMs)
  },
})
```

| Field | |
| --- | --- |
| `stepNumber`, `model`, `messageId` | identity |
| `content`, `toolCalls`, `toolResults` | what happened |
| `finishReason` | why the turn ended |
| `usage`, `costDelta` | **this step's** consumption, not the running total |
| `startedAt`, `durationMs`, `toolExecutionMs` | timing, split by phase |

`toolResults` is ordered by the tool *calls*, so it lines up with
`toolCalls` index for index.

## 3. Transient Provider Failures

Model calls are retried by default with exponential backoff and full
jitter, honouring a server-sent `Retry-After`.

```ts
query({
  // …
  retry: { maxRetries: 5, initialDelayMs: 1_000 }, // or `false` to opt out
})
```

Only failures **before the first content chunk** are retried. Once a delta
has been yielded the consumer has already emitted `text_delta` events and
cannot un-emit them, so a mid-stream failure is surfaced rather than
replayed.

Failures are classified into `ProviderError` with a `code`, a `retryable`
flag, the HTTP `status` and a parsed `retryAfterMs`:

| Code | Retried |
| --- | --- |
| `rate_limit`, `overloaded`, `server_error`, `timeout`, `network` | yes |
| `auth`, `invalid_request`, `not_found`, `content_filter` | no |
| `context_length_exceeded` | no — the prompt must shrink first |

`context_length_exceeded` is deliberately separate from the generic 400:
it is the one 4xx a caller can act on.

Aborts propagate untouched, so a Stop still settles the run as
`cancelled` rather than being mistaken for a transport failure.

## 4. Budgets Across a Resume

`query({ resumeFromCheckpoint })` restores `tokenUsage`, `costInfo`,
the iteration count **and elapsed wall-clock** from the checkpoint. A run
recalled at $4.80 of a $5 cap continues from $4.80; it does not get a
fresh envelope.

Side-channel model calls — advisory consultations, the compaction
verifier, agent routing — are counted against the same budgets.

## 5. Shaping Each Step

`stopWhen` decides whether to keep going. `prepareStep` decides *how* the
next step should look — the other half of the same idea.

```ts
query({
  prepareStep: ({ stepNumber, steps, messages }) => {
    if (stepNumber <= 3) return { activeTools: ['search', 'read_file'] }
    return { activeTools: ['write_file'], model: 'claude-haiku-4-5-20251001' }
  },
})
```

The hook receives the run id, the step number, the full message history
and every completed `StepResult`. It may return `activeTools`, `model`,
`system`, `temperature` and `maxResponseTokens`; an omitted field keeps
the run's configured value, and returning nothing is the same as having no
hook.

Without it the tool surface and the model are fixed at `query()` time, so
a phased agent — research, then write, then verify with a cheaper model —
had to be several separate runs, each starting blind to the last one's
context.

Four things worth knowing:

- **`system` is one-step guidance.** It is appended to the *request* and
  never pushed onto the run's history, so a long run does not accumulate
  one stale phase instruction per iteration.
- **`activeTools` costs a prompt-cache prefix.** Tools render at position
  0, so changing the set invalidates the cached prefix for that step. That
  is inherent to narrowing — worth paying at a real phase boundary, not
  every step.
- **It does not touch `tool_choice`.** Anthropic has no `allowed_tools`
  parameter, and moving `tool_choice` invalidates cached *message* blocks
  as well: a strictly worse trade for the same effect.
- **It fails open.** A throwing hook leaves the step with the run's
  configuration, and tool names that are not registered are dropped with a
  warning — a phase list that outlives a tool rename should narrow the
  surface, not kill the agent mid-run.

## 6. Context Compaction

Compaction triggers on **window pressure**, measured against the model's
context window:

1. `compactionConfig.contextWindowTokens` if you set it,
2. otherwise resolved from `runConfig.model`,
3. otherwise a conservative 128k default.

`tokenBudget` is never the divisor — it is a cumulative spend cap, a
different quantity, and comparing a live context against it is
self-defeating.

Context size prefers the provider's reported `promptTokens` from the last
turn over a character heuristic, because it counts what the heuristic
cannot see: tool schemas, system blocks, image tokens, per-message
framing.

That measurement describes the prompt as it was **sent**, so everything the
turn appended afterwards — the assistant message and every one of its tool
results — falls outside it. The reported number therefore has an estimate
of that tail added to it. Reading it verbatim made the trigger one full
turn stale, and the staleness is largest on exactly the turns that add the
most: a turn returning 200 KB of tool output counted as if it had returned
nothing. The character-heuristic fallback (used before any turn has
reported, and for providers that return no usage) now includes the tool
catalogue too — a 30-tool registry is easily 10-20k tokens of JSON Schema
that shipped with every request and entered no estimate at all. Both
omissions biased the same way, under-count, so the trigger did not jitter
around the threshold; it sat systematically late.

### Clearing stale tool output first

Before summarizing, the pass clears the **output** of old, large tool
results in place — replacing it with a short placeholder naming the tool
and its original size. If that gets the context back under
`triggerThreshold`, summarization is skipped entirely and the history stays
verbatim.

The ordering is the point. Summarization paraphrases away the agent's own
reasoning — the decisions, the false starts it learned from, the exact
wording of a plan — and that is a heavy price for a context problem usually
caused by something much dumber: a handful of enormous tool outputs the
agent already read and moved past. Clearing them is also *safe* where
trimming is not, because nothing moves: the `tool` message keeps its
position and its `toolCallId`, so `tool_use` ↔ `tool_result` pairing holds
by construction.

| Field | Default | Meaning |
|---|---|---|
| `clearToolResults` | `true` | Set `false` to go straight to summarization. |
| `keepRecentToolResults` | `3` | Most recent results left alone — still in use. |
| `minToolResultCharsToClear` | `1000` | Below this the placeholder costs as much. |
| `preserveToolResultsFrom` | — | Tool names never cleared. |

Never cleared: an **error** result (small, and it is what steers the next
turn), the most recent N, and anything under the size floor. Image payloads
are measured by their base64 size — a screenshot is the largest thing a
tool result can carry and exactly the kind of output an agent reads once.

A pass emits `compaction_completed` (wire: `compaction.completed`) with
before/after message counts and token sizes. Compaction deletes history
irrecoverably, so it is worth surfacing.

## 7. Extended Thinking

```ts
query({
  runConfig: {
    model: 'claude-opus-5',
    thinking: { type: 'enabled', budgetTokens: 8_000 },
  },
})
```

Reasoning blocks are stored on the assistant message and replayed
**verbatim**, signature intact — Anthropic requires the assistant turn
preceding a `tool_result` to be echoed back unchanged, and a rebuilt turn
triggers ordering and signature errors.

The lifecycle surfaces as `reasoning_started` / `reasoning_delta` /
`reasoning_completed`, so a streaming UI can show that the model is
working instead of a silent multi-second gap. The delta is ephemeral: the
completed block carries the full text, and the transcript records that.

Anthropic rejects `temperature`, `top_p` and `top_k` while thinking is
enabled, so the driver omits them rather than sending a request it knows
will fail.

## 8. Guardrails

The three gates on tool calls — probe veto, `VerificationGate`, HITL review
— all point the same way: they protect the world from the agent. Guardrails
are the other direction.

```ts
import { secretRedactionGuardrail } from '@namzu/sdk'

query({
  inputGuardrails: [({ messages }) => /* … */ ({ action: 'pass' })],
  outputGuardrails: [secretRedactionGuardrail()],
})
```

- **Input** guardrails run before the first model call, so a refusal costs
  nothing. A block settles the run as `input_guardrail`.
- **Output** guardrails run against the final result. A block settles as
  `output_guardrail`; a `rewrite` replaces the text, so a redaction policy
  can clean an answer rather than discard it. Rewrites compose.
- A guardrail that **throws fails closed**, deliberately the opposite of
  `stopWhen`: a broken halt predicate should not kill a healthy run, but a
  broken safety check must not wave content through.

Both stages emit `guardrail_triggered` (wire: `guardrail.triggered`).

> **Output guardrails gate the result, not the stream.** `text_delta`
> events have already reached the host by the time one runs, so a rewrite
> arrives as a *correction* alongside the event. Gating the stream itself
> would mean buffering every token — trading the streaming UX for the
> guarantee — which is a host decision, not the SDK's.

Presets: `secretRedactionGuardrail(options)` (prefix-anchored credential
patterns; redacts by default, `onMatch: 'block'` to refuse) and
`promptInjectionGuardrail()` (partial by design — it raises the cost of the
lazy attack, it is not a boundary).

## 9. Repairing a Bad Tool Call

A malformed call otherwise costs a full round trip: the error goes back as
a `tool_result`, the model re-reads the entire context, and issues a second
inference to add a missing brace.

```ts
query({
  repairToolCall: async ({ toolCall, reason, jsonSchema, availableTools }) => {
    if (reason !== 'invalid_json') return null
    return { arguments: await fixJson(toolCall.function.arguments, jsonSchema) }
  },
})
```

The hook sees the reason (`invalid_json`, `schema_validation`,
`unknown_tool`), the tool's JSON Schema and every registered tool name, and
may rewrite the **arguments** and the **tool name** — nothing else. It
cannot invent a call the model never made, nor suppress one.

It is tried exactly once (a repairer that produces a still-broken call will
not do better on a second look, and an unbounded loop is a hang). A throw
is caught. Declining with `null` is normal: the original error proceeds to
the model as before.

### Per-tool retry budget

```ts
const tool: ToolDefinition = {
  name: 'fetch_page',
  maxRetries: 2,
  execute: async () => ({ success: false, output: '', error: 'ECONNRESET', retryable: true }),
  // …
}
```

`maxRetries` **defaults to 0, and that default is load-bearing.** Retrying
is only safe if the tool is idempotent and the SDK cannot know that:
silently re-running a write, a `git push` or a payment is worse than never
retrying. Even opted in, only failures the tool marked `retryable` are
retried — a missing file will not appear on the second attempt.

A `post_tool_use` plugin hook returning `{ action: 'retry' }` also re-runs
the tool, bounded by the same budget.

## 10. Typed Failures

```ts
import { toPlatformError } from '@namzu/sdk'

try {
  await drainQuery(params)
} catch (err) {
  const { code, message, retryable, details } = toPlatformError(err)
}
```

`toPlatformError` normalizes **anything** thrown into one shape — a
`NamzuError`, a `ProviderError`, a plain `Error` from a dependency, or a
thrown string — so "handle errors from the SDK" is one handler rather than
an `instanceof` ladder per call site. A `ProviderError` keeps its own
classification: its code lands in `details.providerCode` and its
`retryable` verdict is preserved, not recomputed.

`NamzuErrorCode` is deliberately small — each member exists because a
caller does something different about it: `invalid_config`,
`provider_error`, `tool_error`, `not_found`, `plugin_error`,
`capability_unavailable`, `storage_error`, `unknown`.

## 11. Crash Save

```ts
query({ emergencySave: true })
```

Installs SIGINT / SIGTERM / `uncaughtException` handlers that dump run
state to `<runDir>/../emergency/<runId>.json`, readable by
`replay({ fromCheckpoint: 'emergency' })`. Handlers are removed when the
run settles.

**Off by default, deliberately.** Attaching means calling `process.on(...)`
with handlers that `process.exit()`; a library must not seize its host's
termination path, and an API server has its own drain sequence. The
manager is also a singleton, so under concurrent runs an automatic attach
would make the last-started run the only one ever saved. Turn it on for a
process that owns its run end to end — a CLI, a single-run worker.

## Related

- [SDK Runtime](./README.md)
- [Runtime Configuration](./configuration.md)
- [Replay and Checkpoints](./replay.md)
- [SDK Tools](../tools/README.md)
- [Telemetry](../observability/README.md)
