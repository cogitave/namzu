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

## 5. Context Compaction

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

A pass emits `compaction_completed` (wire: `compaction.completed`) with
before/after message counts and token sizes. Compaction deletes history
irrecoverably, so it is worth surfacing.

## 6. Extended Thinking

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

## 7. Crash Save

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
