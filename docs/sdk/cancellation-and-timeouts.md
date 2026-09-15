---
type: Design
title: Cancellation and timeouts
description: Findings and open composition options for provider-request cancellation, the whole-run timeout gap, and the two idle-timeout mechanisms — verified against the current branch.
resource: packages/sdk/src/runtime/query/index.ts
tags: [sdk, provider, cancellation, timeout, retry, fallback]
status: draft
generated: { by: process:claude-code, at: 2026-09-15T00:00:00Z }
---

# Cancellation and timeouts

This page records findings and options, not a committed design. Every claim
below was checked against this branch's source at the line cited; where an
earlier internal review disagreed with itself, this page says which reading
the code actually supports and why. Nothing here has shipped or been decided.

## Today's three layers, briefly

A run's cancellation and timeout behavior is built from three independent
mechanisms, composed in sequence:

- **Per-call `AbortSignal`.** `ChatCompletionParams.signal` is optional and
  inert when unset (`packages/sdk/src/types/provider/chat.ts:62`).
- **Run-level `AbortController`.** `RunContext` owns one controller per run
  and fuses a caller-supplied `config.signal` into it one-directionally — a
  caller abort propagates in, never out
  (`packages/sdk/src/runtime/query/context.ts:167-196`). The turn loop races
  each `it.next()` against this signal so a Stop can interrupt mid-token
  (`packages/sdk/src/runtime/query/iteration/stream-turn.ts:271-297`, driven
  by `this.ctx.abortController.signal` at
  `packages/sdk/src/runtime/query/iteration/index.ts:886`).
- **Kernel idle watchdog.** `withStreamIdleTimeout` enforces a per-chunk
  silence bound (default five minutes,
  `packages/sdk/src/provider/idle-timeout.ts:7`) by racing the same iterator
  and re-arming a timer on every chunk; it is unwrapped entirely when
  `idleTimeoutMs <= 0`.

`AgentRunConfig.timeoutMs` is a fourth, separate concept: a whole-run
wall-clock budget. The adjacent `streamIdleTimeoutMs` field's doc comment
contrasts itself against it, saying plainly that `timeoutMs` "is checked
between agent iterations and cannot settle a provider iterator whose pending
`next()` never returns" (`packages/sdk/src/types/run/config.ts:17-18`), and
the only two call sites that enforce it —
`packages/sdk/src/runtime/query/iteration/index.ts:473` and `:2733` — are
both between-iteration checks in `GuardCoordinator.beforeIteration`
(`packages/sdk/src/runtime/query/guard.ts:104-147`, confirmed as the only two
call sites by a full-tree grep). A single turn that keeps producing chunks,
however slowly, can therefore overrun `timeoutMs` by the length of that turn.

## 1. The composition-order trap for a deadline decorator

The obvious fix — add a decorator that races the whole `chatStream`
generator against `guard.remainingUntilTimeoutMs()` and compose it at the
same point as the idle watchdog — does not do what it looks like it does if
composed naively, because of where retry and fallback sit relative to that
point.

The composition point is `withRecovery`, built once per call to `query()`
and applied to every chain member before `withProviderFallback` wraps them
into `resilientProvider`:

```ts sketch
const withRecovery = (provider: LLMProvider): LLMProvider => {
  const withIdleBound = withStreamIdleTimeout(provider, { idleTimeoutMs, log })
  const metered = withTokenBudget(withIdleBound, budget)
  return params.retry === false ? metered : withProviderRetry(metered, { config, log, canRetry })
}
// packages/sdk/src/runtime/query/index.ts:1124-1137
const resilientProvider = withProviderFallback(
  chain.map((member) => ({ ...member, provider: withRecovery(member.provider) })),
  { log, canFallback, onSwap },
) // packages/sdk/src/runtime/query/index.ts:1148-1163
```

Both `withProviderRetry` and `withProviderFallback` special-case one kind of
failure and let everything else go through their ordinary recovery path.
Retry bypasses its own logic only when `isAbortError(err) ||
params.signal?.aborted` (`packages/sdk/src/provider/retry.ts:117`), and
fallback does the identical check before asking whether to swap providers
(`packages/sdk/src/provider/fallback.ts:421`). `isAbortError` recognizes an
`Error` only by `.name === 'AbortError' | 'TimeoutError'`, or a bare
`.name === 'AbortError'` on a non-`Error` value
(`packages/sdk/src/types/provider/errors.ts:120-127`). A new
`ProviderRequestError` — the type the kernel already uses for its own
classified failures — always sets `this.name = 'ProviderRequestError'`
(`packages/sdk/src/provider/errors.ts:82`), regardless of what `kind` it
carries. So a deadline decorator that throws `ProviderRequestError({ kind:
'timeout' })` from *inside* `withRecovery` is invisible to `isAbortError`,
and both decorators run their ordinary recovery logic on it.

For retry, that is close to harmless: `KIND_TO_CODE` has no `'timeout'` entry
(`packages/sdk/src/types/provider/errors.ts:378-385`), so
`classifyFromProviderRequestError` returns `undefined`
(`errors.ts:400-401`) and classification falls through to the generic
path, landing as non-retryable in practice — exactly the reasoning the
existing idle-timeout test documents for why it deliberately reuses
`kind: 'network'` instead of inventing one: "retry and fallback already know
how to act on that classification, and a bespoke one would reach them as an
unknown they treat as fatal"
(`packages/sdk/src/provider/__tests__/a-stream-that-stops-is-noticed.test.ts:90-92`).

For fallback, "treated as fatal" is not what actually happens. `shouldFallOver`
decides purely from `code` membership in a fixed set —
`REQUEST_FAULT_CODES = {context_length_exceeded, invalid_request,
content_filter}` (`packages/sdk/src/provider/fallback.ts:169-173`) — and
returns `!REQUEST_FAULT_CODES.has(classified.code)`
(`packages/sdk/src/provider/fallback.ts:191-194`). It does not consult
`retryable` at all. An unmapped `kind: 'timeout'` classifies to some code
outside that set, so `shouldFallOver` returns `true` and the chain falls
over to the next provider (`packages/sdk/src/provider/fallback.ts:426`).

Net effect: a deadline cut composed inside `withRecovery`, exactly where the
idle watchdog sits, earns the failed member a fresh retry attempt and/or a
fresh backup provider — each free to run for a further stretch of wall-clock
time. A wall-clock deadline meant to bound a run's duration would make some
runs overrun `timeoutMs` by *more* than today's one-turn overrun, not less.

Two shapes avoid this, and neither is exotic in this codebase:

- **Abort the run's own `AbortController`.** Reuse the Stop path exactly —
  the run already settles as `cancelled` with partial spend persisted while
  the provider remains blocked, per the existing kernel-level test
  (`packages/sdk/src/runtime/query/__tests__/cancelled-provider-receipts.test.ts:17-18`).
  A deadline cut would need a distinct stop reason so an operator can tell
  "the model stopped it" apart from "the clock did," but the settlement,
  persistence and retry/fallback bypass are already correct because
  `isAbortError` and `params.signal?.aborted` both already short-circuit on
  an aborted run signal.
- **Compose the deadline outside `resilientProvider`.** Wrap the whole
  recovered chain once, after `withProviderFallback` returns, so retry and
  fallback never see the cut at all — they only see whatever the wrapped
  call raises if it doesn't return in time, i.e. nothing, because the outer
  wrapper already gave up on it.

Both need to preserve output already yielded rather than silently dropping
it, matching the idle-timeout decorator's own constraint of not un-emitting
a chunk.

## 2. A retry backoff must not count against the deadline

Whichever shape point 1 lands on, a provider-directed retry's backoff sleep
must not be charged against the same deadline being used to cut a stalled
turn short. The kernel already had to learn this once for the idle watchdog:
the ordering comment above `withRecovery` states it directly — "The idle
layer cannot sit outside retry, because its timer would then count a
legitimate backoff as provider silence. This order is not a preference."
(`packages/sdk/src/runtime/query/index.ts:1098-1117`, with the quoted
sentence at `index.ts:1110-1112`). A wall-clock deadline decorator has the
same failure mode in reverse if it sits *inside* retry: a backoff sleep
between attempts would burn down a budget meant to bound provider work, not
the kernel's own waiting. This is a constraint on the eventual composition,
not a solved problem — it is named here so a future change is checked
against it explicitly.

## 3. Deriving a per-call deadline is not novel

The part of a "kernel-enforced deadline" that sounds hardest — turning
"wall-clock time left in the run" into a bounded, fusable signal — already
has two working precedents in this exact codebase:

- `GuardCoordinator.remainingUntilTimeoutMs()` returns
  `Math.max(0, timeoutMs - elapsed)`, or `+Infinity` when `timeoutMs === 0`
  (`packages/sdk/src/runtime/query/guard.ts:91-101`), and today feeds exactly
  one caller: sandbox acquisition's own `timeoutMs`
  (`packages/sdk/src/runtime/query/index.ts:2603`).
- `resolveProviderContextWindow` clamps a caller-supplied `timeoutMs` against
  Node's 32-bit timer ceiling, arms a private `AbortController`, and fuses it
  with the caller's signal via `AbortSignal.any` before racing a
  context-window lookup against it
  (`packages/sdk/src/runtime/query/index.ts:918-950`).

The open work in point 1 is composition order relative to retry and
fallback, not how to read a deadline or build a fused signal from it.

## 4. Advisory and callback-inference calls compose differently

Any deadline work has to be specified against all three call shapes, because
they are not one object reused three ways:

- **Primary turns.** `resilientProvider` — the full
  idle → token-budget → retry chain, wrapped again in fallback — is what
  becomes `ctx.provider`: passed into `RunContext` at
  `packages/sdk/src/runtime/query/index.ts:1319` and into
  `IterationOrchestrator` at `index.ts:1998`.
- **Callback inference** (`preparation`/`review` phases) reads `ctx.provider`
  directly (`packages/sdk/src/runtime/query/callback-inference.ts:66`), so it
  gets the same `resilientProvider`. It also composes its own extra,
  independent deadline on top: a per-call `AbortController` capped at 10
  seconds (`requestSchema.timeoutMs` max, `callback-inference.ts:13`), fused
  via `AbortSignal.any([ctx.abortController.signal, lifetime.signal,
  deadline.signal, ...requestedSignal])` at `callback-inference.ts:42-51`.
- **Advisory calls** get neither retry nor fallback. `index.ts:1929-1938`
  builds `boundedAdvisors` directly from `advisor.provider`:
  `withTokenBudget(withStreamIdleTimeout(advisor.provider, {
  idleTimeoutMs, log }), budget)` — idle-timeout and token-budget only. They
  are protected from an unbounded stall but are not retried and never fail
  over to a different provider the way primary turns and callback inference
  are.

A prior internal pass over this code claimed one `resilientProvider` object
was "handed to IterationOrchestrator, advisory calls, and callback-inference."
That is not what the code does: advisory calls get a narrower, separately
built composition. Any deadline mechanism has to say explicitly which of
these three shapes it applies to, since "apply it where idle-timeout is
applied" resolves to two different code paths today.

## 5. Scope includes the RAG embedding provider

`HttpEmbeddingProvider` (`packages/sdk/src/rag/embedding.ts`) is a fourth,
provider-shaped outbound-request surface with its own timeout and its own
abort-fusion, entirely outside the `LLMProvider`/`chatStream` interface the
rest of this page describes:

- `requestTimeoutMs` resolves from `config.requestTimeoutMs`, defaulting to
  30 seconds (`DEFAULT_EMBEDDING_REQUEST_TIMEOUT_MS`,
  `packages/sdk/src/rag/embedding.ts:8`; resolution at `embedding.ts:12-20`,
  assigned at `embedding.ts:79`).
- `callEmbeddingApi` builds its own transport `AbortController`, fuses a
  caller signal into it one-directionally, and races the request against
  both the caller's abort and its own timeout
  (`packages/sdk/src/rag/embedding.ts:103-156`).

This surface has a documented, previously-shipped regression of exactly this
page's failure class: "the RAG tool dropped [the per-tool abort signal]
before `KnowledgeBase.query`... A stopped run therefore detached after its
own wait bound while the owned embedding request kept running," fixed and
pinned by
`packages/sdk/src/runtime/query/__tests__/rag-embedding-cancellation-reaches-run.test.ts:17-23`.
Any conformance work scoped to "every provider-shaped outbound call the
kernel owns" should name this surface explicitly rather than silently
excluding it because it isn't a `packages/providers/*` package.

## 6. The CLI adds a third `AbortSignal` composition layer

The reported "extra cancel signal" symptom is more likely to originate here
than in the SDK, and this layer was not on the SDK's own map of the
cancellation model. `SessionOperationOwner` in the CLI TUI owns a
session-lifetime `AbortController`
(`packages/cli/src/tui/agent.ts:863`, aborted on `close()` at
`agent.ts:1013`) and fuses it with the caller's own signal before the SDK
ever sees anything:

```ts sketch
private operationSignal(callerSignal: AbortSignal | undefined): AbortSignal {
  if (this.closed) throw this.closeReason
  if (this.exclusiveOperation) throw new Error(...)
  return callerSignal
    ? AbortSignal.any([callerSignal, this.lifetime.signal])
    : this.lifetime.signal
} // packages/cli/src/tui/agent.ts:1018-1024
```

That fused signal reaches `query()` through `operations.stream(opts?.signal,
...)` (`agent.ts:2860`), which captures it into `turnOpts.signal`
(`agent.ts:2865`); the run function destructures it as `const signal =
opts?.signal` (`agent.ts:3787`) and passes it into the `query({ ...,
signal })` call (`agent.ts:3794`, `signal` field at `agent.ts:3861`). A full
CLI turn therefore composes at least three `AbortSignal` layers before any
provider driver sees one: CLI session-lifetime-plus-caller fusion → SDK
`RunContext.abortController` fusion with `config.signal` → the per-call
`ChatCompletionParams.signal`. A fix scoped only to `packages/sdk` would miss
whatever this layer contributes to a duration or double-cancel symptom, so
it should be opened directly rather than inferred from SDK-side evidence.

The nearest research artifact,
`research/conversation-evidence/capture-cancellation-{cli.mjs,results.md}`,
is about tool-executor deadline cancellation of an evidence-capture call
(the store closure kept observing a stale snapshot after a tool's own
deadline) — confirmed by reading `capture-cancellation-results.md`. It is
not about the provider stream and should not be treated as prior evidence
for this symptom.

## 7. Two idle-timeout mechanisms, no shared documentation

- **Kernel.** `withStreamIdleTimeout`, default 300,000 ms
  (`packages/sdk/src/provider/idle-timeout.ts:7`), applied centrally inside
  `withRecovery` for every call shape that goes through `query()`.
- **Anthropic driver.** Its own, independently configured
  `streamIdleTimeoutMs`, default `0` (off)
  (`packages/providers/anthropic/src/client.ts:48`, applied at
  `client.ts:1150`). The public field's doc comment explains the default:
  "Optional per-event stream idle watchdog in ms. Disabled by default. Use
  only for deployments that need to fail a stalled SSE connection
  independently from the request timeout."
  (`packages/providers/anthropic/src/types.ts:24-29`, field at `types.ts:29`).

Setting `AgentRunConfig.streamIdleTimeoutMs` does not touch the Anthropic
driver's own knob, and vice versa; nothing in `docs/` names either config
surface today (see point 9). Open question this page does not resolve:
retire the driver-local watchdog now that the kernel-level one exists for
every caller that goes through `query()`, or keep it for direct
`@namzu/anthropic` callers that never pass through the SDK runtime at all
(a real, if narrower, audience).

## 8. Reader cleanup differs across fetch-based drivers

On abort, `http` and `openrouter` release the stream reader without
cancelling it; `zen` does both:

- `packages/providers/http/src/client.ts:606` and `:775` — `finally { reader.releaseLock() }`, nothing else.
- `packages/providers/openrouter/src/client.ts:299` — same: `finally { reader.releaseLock() }`.
- `packages/providers/zen/src/client.ts:429-430` and `:582-583` — `await reader.cancel().catch(() => {}); reader.releaseLock()`.

A shared conformance contract over an injectable fake transport (per-provider
fixture adapters where transports differ materially — LM Studio's SDK-mediated
handle, Bedrock's AWS SDK client, Zen's `options.abortSignal`) would surface
this as a failing assertion rather than a read-time observation, since
nothing today asserts reader cleanup uniformly across drivers.

## 9. This page is the first documentation of the model

`streamIdleTimeoutMs` is a public `AgentRunConfig` key
(`packages/sdk/src/types/run/config.ts:22`) with no dedicated `docs/` page
describing the cancellation/timeout model before this one; the only prior
mention anywhere in `docs/` is one line in
`docs/sdk/native-structured-output.md:113`. This page is a first step, not a
replacement for a real reference page once the composition question in
point 1 is settled.

The open decision this page surfaces but does not make: if a stream-aware
whole-run `timeoutMs` ships, should it cut a stalled turn by default, or only
when explicitly opted into? Under this repo's SemVer rule (bump intent is a
claim about the consumer, not about effort), making it the default is
`major` — a run that previously overran its deadline by one turn's length
now gets cut mid-turn, which is a backward-incompatible behavior change for
any caller relying on that overrun. Shipping it behind a new, unset-by-default
config key is `minor`.
