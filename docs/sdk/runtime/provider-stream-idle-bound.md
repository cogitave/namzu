---
uid: namzu.sdk.runtime.provider-stream-idle-bound
title: Provider stream idle bounds
description: Reference for the finite provider-stream silence bound, its relationship to run timeouts, retry and fallback composition, cancellation semantics, configuration limits, and the explicit compatibility opt-out.
type: Reference
diataxis: reference
owner: cogitave/namzu
status: active
timestamp: 2026-08-24T00:00:00Z
lastReviewed: 2026-08-25
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

Advisors configured on a query may use providers that are not members of the
main chain. The query applies the same effective idle bound and its internal
cancellation signal to every triggered and model-requested advisory call.
Those calls do not acquire the main provider's retry or fallback policy: a
triggered advisory idle failure is logged and swallowed under the advisory
phase's existing best-effort semantics, then the main run continues. A caller
or operator cancellation closes the pending advisor transport and retains its
ordinary cancelled-run meaning.

`RouterAgent` makes one model call before its delegate run exists, so that
routing call cannot inherit `query()` composition. It resolves the same
`streamIdleTimeoutMs` policy explicitly. An idle routing call enters the
router's declared route fallback; a caller or agent cancellation is preserved
instead and never starts a fallback delegate.

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

A caller signal that was already aborted before `query()` begins is mirrored
into the run synchronously. The run settles as cancelled without starting a
main, advisory, or tool request; abort events are not replayed to listeners, so
this initial-state check is separate from the listener used for later stops.

Before that run controller exists, `query()` may ask the driver for optional
context-window metadata. This is not a provider stream, so
`streamIdleTimeoutMs` does not time the lookup. The run's `timeoutMs` is its
finite preflight deadline: expiry aborts a private metadata-transport signal
and falls back to the static context-window table. The normal
between-iteration guard starts after preflight and uses the same configured
interval for run work.

Caller cancellation remains distinct from that deadline. An already-aborted
caller does not enter the resolver, and a later abort stops waiting even if a
third-party resolver leaves its promise pending. The caller's exact reason is
fused into the private signal passed to a cooperative driver, so it can close
its metadata transport without either cancellation path aborting the caller's
own controller.

Plugin hooks are not provider streams and do not borrow the provider idle
timer. Their own hook deadline is fused with this same run cancellation signal
at all eight run, iteration, model, and tool boundaries. The lifecycle manager
also races cancellation independently, so a hook promise that ignores its
signal cannot keep the run waiting or publish a late completed-hook event.
Cancellation before the iteration loop—including a held `run_start` or
`pre_llm_call` hook—settles as `cancelled` and starts no provider request.
In-process plugin code remains cooperative: its I/O and external side effects
must honor the supplied signal even though the runtime has stopped awaiting
its result.

## Stored attachment resolution

Stored image and document references are resolved under the same caller-owned
run signal before prompt contributions, guardrails, project preparation, or
provider work begin. Resolution also owns a separate one-minute phase deadline;
unlike the provider stream idle bound, it measures the complete parallel store
materialization phase. `attachmentResolveTimeoutMs` selects another bound and
`0` is the explicit unbounded compatibility mode. A signal that is already
aborted wins before attachment store admission. A later cancellation or phase
deadline is raced independently, so a custom or remote store that ignores its
signal cannot hold the run open or publish a late result.

`AttachmentStore.get` receives an optional `AttachmentOperationOptions` value.
Store implementations should use its signal to close their own I/O; the
runtime's independent race bounds settlement but cannot reclaim resources the
store itself owns. The caller's controller remains untouched.

A cancelled run retains the unresolved attachment reference in its durable
messages. Canonical `resumeRun` also carries its already-selected checkpoint
history, usage, attribution, trace parent, and queued messages into this
callback-free cancellation path. It does not reread the checkpoint after
cancellation, invoke model-adjacent host callbacks, or replace prior durable
history with an incomplete snapshot. Contradictory run, session, topic,
project, tenant, or explicit parent attribution is refused before attachment
or provider work.

See [Stored attachment resolution](./stored-attachment-resolution.md) for the
agent front doors, exact timeout error, configuration range, and batch
semantics.

## Compaction verification

Structured compaction can make a verifier model call before replacing older
history. Inside `query()`, that call uses the run's already-composed provider
chain and carries the run cancellation signal to the verifier transport. Stop
therefore closes a pending verifier with the same cause and settles the run as
cancelled.

The query path deliberately does not wrap that chain a second time. Its order
remains `fallback(retry(idle(provider)))`, so a server-directed retry wait is
not measured as provider-stream silence by an outer timer. The idle bound
applies to each provider attempt; retry backoff remains under the retry policy.

The host-callable `buildVerifiedSummary`, `compactNow`, and `compactRegion`
paths receive a raw provider instead. They apply the shared finite idle default
themselves and accept `signal` plus `streamIdleTimeoutMs`. Set the latter to a
positive integer to choose another per-chunk bound, or to `0` only when the host
already owns an equivalent watchdog. Invalid values and an already-aborted
signal are refused at manual-compaction admission, including when the selected
history would otherwise produce a no-op.

`compactNow` and `compactRegion` also return the exact `TokenUsage` reported by
that verifier. A zero record means the pass needed no verifier request. These
functions run outside a query and therefore have no run ledger to charge; the
result is the accounting handoff to the host that asked for the work.

## Evaluation judges

`judgeScorer` is also a model-calling front door. It applies the shared finite
stream-idle default even when its `score()` method is called directly. Set
`streamIdleTimeoutMs` in `JudgeScorerConfig` to choose another per-chunk bound,
or set `0` for explicit unbounded compatibility.

Inside `runExperiment`, `timeoutMs` is one wall-clock budget for the whole
case: the run closure and every scorer share it. A stalled run becomes a failed
case; a scorer that exhausts the remainder is recorded as unavailable, so a
case with no other measurement is inconclusive and later cases still run. The
harness races non-cooperative work independently and passes the same deadline
signal to `Scorer.score`; the built-in judge carries it through its private
idle wrapper to the provider transport without aborting the case controller.

Omitting `timeoutMs` leaves the case budget unbounded. A configured value must
be an integer from `1` through the platform timer maximum
(`2,147,483,647`); zero, negative, fractional, non-finite, and over-range values
are refused before any case starts. The case deadline and the judge idle bound
measure different things: total case wall time versus silence between judge
chunks.

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
composition boundary. Query-owned compaction verification reuses that composed
provider and adds only the run signal; host-triggered compaction wraps its raw
provider locally. Query-owned advisor providers receive the same bound and run
cancellation separately because they are not members of the main chain.
`RouterAgent` applies the same config to its separate routing decision before
it enters a delegate's `query()` boundary.

Live project-instruction preparation and its post-tool snapshot publications
are host callbacks, not provider streams. They run outside this composition:
before request one and immediately after a complete tool-result batch,
respectively. The runtime passes them its cancellation signal and races even a
non-cooperative callback against withdrawal. Each accepted observation is
published before the next callback starts, so cancellation retains the
accepted prefix and rejects the unfinished suffix. These callbacks neither
reset the provider silence timer nor create a model continuation, so a terminal
batch can persist context without opening another provider request.
