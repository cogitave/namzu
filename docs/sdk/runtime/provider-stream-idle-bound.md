---
uid: namzu.sdk.runtime.provider-stream-idle-bound
title: Provider stream idle bounds
description: Reference for the finite provider-stream silence bound, its relationship to run timeouts, retry and fallback composition, cancellation semantics, configuration limits, and the explicit compatibility opt-out.
type: Reference
diataxis: reference
owner: cogitave/namzu
status: active
timestamp: 2026-08-19T00:00:00Z
lastReviewed: 2026-08-19
resource: packages/sdk/src/runtime/query/index.ts
tags: [sdk, runtime, providers, retry, cancellation]
---

# Provider stream idle bounds

A model request can open successfully and then stop producing bytes. That is
not a slow iteration and it is not a request that failed to connect: one
pending `AsyncIterator.next()` simply never settles. The run's `timeoutMs` is
checked between iterations, so it cannot observe or end that state.

`query()` therefore bounds the silence between provider chunks. The shipped
default is `DEFAULT_STREAM_IDLE_TIMEOUT_MS`, currently **300,000 ms (five
minutes)**. The effective value is written to `Run.metadata.config`, including
when the caller relied on the default, so persisted run evidence does not
change meaning when a later release changes its default.

## Configure the bound

`streamIdleTimeoutMs` is available on `AgentRunConfig`, the ergonomic agent
configs, `runAgent()` options, and directory `agent.ts` config.

```ts
import { runAgent, type LLMProvider } from '@namzu/sdk'

declare const provider: LLMProvider

await runAgent({
  provider,
  model: 'model-id',
  prompt: 'Summarize the incident.',
  streamIdleTimeoutMs: 30_000,
})
```

The raw SDK boundary accepts integer milliseconds from `0` through the
platform timer maximum (`2,147,483,647`). The public wire schema narrows that
to one hour. Negative, fractional, non-finite, and over-range values are
refused before a run id or provider request is created.

Set the value to `0` only when another layer already owns an equivalent bound:

```ts
import { runAgent, type LLMProvider } from '@namzu/sdk'

declare const provider: LLMProvider

await runAgent({
  provider,
  model: 'model-id',
  prompt: 'Wait for the external stream supervisor.',
  streamIdleTimeoutMs: 0,
})
```

`0` restores the earlier unbounded-silence behavior. It is an explicit
compatibility option, not the safe default.

## Recovery order

For every declared provider-chain member, the runtime composes resilience as:

```text
fallback(retry(idle(provider)))
```

The position is part of the contract:

- A stall before output is a network-classified failure, so the same member
  receives its configured retries before the chain advances.
- The idle timer is inside retry. It measures provider silence only; retry
  backoff is not miscounted as a silent stream.
- After text, reasoning, citations, or tool input has been emitted, neither
  retry nor fallback restarts the request because doing so would duplicate
  already-observed output.

The final exhausted error reaches `run_failed` with `kind: 'network'`, the
provider id, and the exact idle duration.

## Cancellation and transport closure

The watchdog creates one transport signal for each provider request and passes
that signal to the driver. When the bound expires, it aborts that signal with
the same `ProviderRequestError` that settles the iterator. This closes a driver
that is waiting on a socket instead of merely abandoning a JavaScript promise.
The caller's own `AbortController` is never aborted.

Provider libraries differ in how they report an aborted request. Some preserve
`signal.reason`; others reject with a generic `AbortError`. The wrapper latches
the first cause before aborting transport. A generic abort caused by the
watchdog is translated back to the network-classified idle error so retry and
fallback remain reachable. A caller cancellation that happened first retains
the caller's original reason and follows the ordinary cancelled-run path.

## Direct provider composition

Hosts that consume a provider outside `query()` can apply
`withStreamIdleTimeout(provider, { idleTimeoutMs })` directly. A positive value
returns a class-safe transparent provider wrapper: identity, capability
declarations, retry defaults, model listing, credential and health probes,
effort levels, and context-window resolution remain available. `0` returns the
original provider object by identity.

Inside `query()`, prefer `streamIdleTimeoutMs` on the run config. The runtime
owns the retry/fallback order there and applies the bound to main turns,
compaction calls, verification calls, and forced-final calls through one
composition boundary.
