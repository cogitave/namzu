---
title: Reliability and Cancellation
description: Typed provider errors, bounded model-call retries, context-overflow recovery, truncated-response handling, cancellation, and history repair in @namzu/sdk.
last_updated: 2026-07-12
status: current
related_packages: ["@namzu/sdk", "@namzu/openai", "@namzu/anthropic", "@namzu/bedrock", "@namzu/openrouter", "@namzu/http", "@namzu/ollama", "@namzu/lmstudio"]
---

# Reliability and Cancellation

A long agent run is a long sequence of network calls, and the interesting failures are the ones that are not bugs: a 429, a context window that filled up three iterations ago, a user who closed the tab. This page covers what the runtime loop does about them, and which parts of it you can configure.

The short version: the loop retries what is worth retrying, compacts and reissues when the window overflows, keeps a truncated response from corrupting the history, and lets a cancel actually reach the socket.

## 0. One Rule Above the Others

Abort and deadline both have **priority over a concurrent response**. If a run is cancelled, or its budget runs out, a response the provider produces in that same moment is discarded — it is not pushed to the history, no tools run from it, and its tokens go unaccounted.

That is deliberate, and it is worth stating plainly because it costs something: a stopped run can be billed for a response you never see. The alternative costs more. Cancellation is a stop signal, not a vote — a run that has been told to stop must not accept more work and act on it, and a run that is out of budget must not spend more of it. For an adapter that cannot honour an abort at all (Ollama's non-streaming path; see `supportsAbortSignal`), the request may still be in flight after the loop has moved on. The guarantee we make is the one we can keep: **the loop stops waiting.**

## 1. The Provider Error Taxonomy

Every provider package normalizes its vendor errors into one `ProviderRequestError`. The runtime makes retry decisions purely off `kind`, so no provider-specific `instanceof` check leaks into the loop.

```ts
import { ProviderRequestError, isProviderRequestError } from '@namzu/sdk'

try {
  await provider.chat({ model, messages })
} catch (err) {
  if (isProviderRequestError(err)) {
    console.log(err.kind)          // 'throttle' | 'context_overflow' | ...
    console.log(err.status)        // upstream HTTP status, when there was one
    console.log(err.retryAfterMs)  // server-advised wait, when the response carried one
    console.log(err.providerId)    // which provider produced it
    console.log(err.cause)         // the original vendor error
  }
}
```

The eight kinds, and what the loop does with each:

| `kind` | Means | Loop behavior |
| --- | --- | --- |
| `throttle` | Rate limited (typically 429) | Retried with backoff, honoring `retryAfterMs` |
| `server` | Upstream 5xx | Retried with backoff |
| `network` | Connection refused, socket error, DNS failure | Retried with backoff |
| `context_overflow` | The input exceeded the model's window | Not a plain retry — triggers compaction and reissue (see section 4) |
| `auth` | 401 / 403 | Terminal. Retrying a bad key just burns the budget |
| `bad_request` | 400 / 404 / 422 | Terminal. Deterministic caller error |
| `aborted` | The caller cancelled | Terminal, immediately |
| `unknown` | Unclassifiable | Terminal, deliberately — hammering an opaque failure is worse than surfacing it |

`classifyHttpStatus(status)` is the shared helper each adapter uses so status mapping is identical across providers. Note that it maps a bare `400` to `bad_request`: context-overflow is not derivable from status alone (it usually arrives as a 400 with a body-level code), so adapters detect that case and pass `kind: 'context_overflow'` explicitly.

## 2. Retry Policy

`RetryConfig` is a field on the run config (`AgentRunConfig.retry`, and the equivalent on `BaseAgentConfig` / `AgentFactoryOptions`). Omit it and the run uses `DEFAULT_RETRY_CONFIG`.

| Field | Default | What it controls |
| --- | --- | --- |
| `enabled` | `true` | Master switch. When `false`, a model call is attempted exactly once |
| `maxAttempts` | `3` | Max *physical* attempts for one logical model call, including the first |
| `baseDelayMs` | `1000` | Base delay for full-jitter exponential backoff |
| `maxDelayMs` | `30_000` | Ceiling on any single wait |
| `overflowAttempts` | `2` | Max compaction-and-reissue passes per iteration (section 4) |

```ts
import { RetryConfigSchema, DEFAULT_RETRY_CONFIG } from '@namzu/sdk'

const result = await agent.run(input, {
  provider,
  tools,
  model: 'gpt-4o-mini',
  tokenBudget: 16_384,
  timeoutMs: 120_000,
  retry: {
    ...DEFAULT_RETRY_CONFIG,
    maxAttempts: 5,
    maxDelayMs: 10_000,
  },
  projectId,
  sessionId,
  tenantId,
})
```

`RetryConfigSchema` is exported for app-level config assembly, and `RuntimeConfigSchema` carries a `retry` key so `RUNTIME_DEFAULTS.retry` is already populated.

Four properties of the retry loop are worth knowing because they are what keep it from becoming its own failure mode:

- **Backoff is full-jitter.** The wait is `random(0, min(baseDelayMs * 2^(attempt-1), maxDelayMs))`, not a fixed ramp, so a fleet of agents throttled at the same instant does not retry in lockstep.
- **`retryAfterMs` wins, but is clamped.** When the provider read a `Retry-After` or rate-limit-reset header, the loop waits that long instead of its computed backoff — but never longer than `maxDelayMs`. A misparsed or hostile hours-long `Retry-After` must not stall the run for its entire remaining budget.
- **It is deadline-aware, including while a request is in flight.** Every wait is capped by the time remaining until the run's guard deadline, the loop checks the deadline before each attempt, and each attempt itself races the deadline. A provider that hangs — or answers long after it was needed — cannot hold the run open: the wait is abandoned at `deadlineAt` and the run stops as `timeout`. Retries cannot push a run past its `timeoutMs`, and neither can a single call.
- **`maxAttempts` bounds physical calls, not logical ones.** Every provider adapter disables its own vendor-SDK retry loop, so the SDK's cap is the real number of requests that hit the network. Without that, `maxAttempts: 3` over a vendor default of 2 internal retries would have been up to nine requests.

An aborted signal short-circuits the loop at any point, including mid-backoff and mid-request — the sleep and the call both race the signal rather than running to completion.

**What "abandoned" means for a provider that cannot be cancelled.** The signal is forwarded to the adapter, so one that honors it (`supportsAbortSignal: true`) tears the request down. One that cannot — Ollama's non-streaming `chat()` takes no signal at all — will keep the HTTP request open until its own transport gives up, and you will still pay for the tokens it eventually returns. The guarantee the runtime can actually make is the one it makes: the loop stops *waiting*, and a late response can no longer flow into hooks, tools, or the message history.

## 3. What Is Retried Outside the Main Loop

Compaction verification, `RouterAgent` routing decisions, and advisory consults call the provider outside the iteration loop. Because vendor-internal retries are off, those calls would otherwise have zero retry coverage and a single transient blip would fail the whole operation. They route through the same bounded path with `DEFAULT_RETRY_CONFIG` and a self-contained 120-second budget rather than the run's (possibly exhausted) deadline. That budget bounds the call itself, not just its retries, so a hung verifier cannot stall a compaction pass indefinitely.

This is internal wiring, not a surface you configure — it is documented because it is genuinely surprising otherwise: a run with `retry.enabled: false` can still emit a retried request, because that setting governs the main loop and these paths carry their own budget.

## 4. Context-Overflow Recovery

A `context_overflow` error is not retried, because retrying the identical oversized payload fails identically. Instead the loop recovers *reactively*, inside the same iteration:

1. Any pending task notifications are drained into the history first, so the reducer summarizes them rather than the reissue silently dropping completed sub-agent results.
2. The messages are force-compacted.
3. The call is reissued with the reduced history.

This repeats up to `retry.overflowAttempts` times (default `2`). If the reduction does not actually shrink the history, the loop does not commit it and rethrows the original error rather than looping on a no-op.

This is distinct from *proactive* compaction, which runs on a token-percentage threshold before the call. Proactive compaction is the normal path; overflow recovery is the safety net for when the estimate was wrong — a model whose real window is smaller than configured, or a tool result far larger than its token estimate suggested.

## 5. Truncated Responses (`finishReason: 'length'`)

When a provider truncates a response mid-generation, any tool call it had started emitting can carry incomplete JSON arguments. The loop handles this rather than letting it corrupt the history:

- Unparseable tool-call arguments are sanitized to `{}` before the assistant message is recorded or re-serialized by any provider.
- A synthesized tool result is written for each truncated call, marking it explicitly as **not executed**. The tools do not run with garbage input.
- The loop continues, so the model can see what happened and retry with a shorter response.

The synthesized result carries a stable `[SYSTEM] Tool not executed: ...` prefix, so downstream summarizers and UIs can recognize it.

## 6. Cancellation

`ChatCompletionParams` carries an optional `signal`. The runtime injects the run's signal on every attempt, so a cancellation aborts the in-flight HTTP request rather than only taking effect at the next iteration boundary.

`AbstractAgent` owns signal composition: it merges the agent's internal controller with any `input.signal` you pass, which is what makes `agent.cancel()` reach a run that is already in flight.

```ts
const running = agent.run(input, config)

// Later, from anywhere:
await agent.cancel()   // aborts the in-flight provider call, not just the next iteration
```

Not every provider can honor it. `ProviderCapabilities.supportsAbortSignal` tells you which:

| Provider | `supportsAbortSignal` |
| --- | --- |
| `@namzu/openai` | `true` |
| `@namzu/anthropic` | `true` |
| `@namzu/bedrock` | `true` |
| `@namzu/openrouter` | `true` |
| `@namzu/http` | `true` |
| `@namzu/lmstudio` | `true` |
| `@namzu/ollama` | `false` — see below |

`@namzu/ollama` declares `false` because the official client's **non-streaming** `chat()` exposes no `AbortSignal` path. Passing a signal only rejects a request that was already aborted before dispatch; otherwise cancellation waits for the next iteration boundary. The streaming path *is* cancellable — `chatStream()` forwards the signal to the vendor iterator's `.abort()`.

If a cancelled run must stop within a bounded time on Ollama, prefer the streaming path.

## 7. History Repair

An interrupted run leaves a history that providers will reject: an assistant message with tool calls whose results never arrived, or a tool result whose call was compacted away. `repairDanglingMessages()` heals such a history instead of deleting the offending turns.

```ts
import { repairDanglingMessages, prepareResumeMessages } from '@namzu/sdk'

const healed = repairDanglingMessages(messages)
```

Three ordered steps:

1. **Drop orphaned tool results.** A `tool` message whose `toolCallId` matches no assistant tool call anywhere is removed — providers reject it and the information is unrecoverable.
2. **Synthesize missing results.** Every assistant tool call with no matching result gets one deterministic error placeholder. Its timestamp is derived from the assistant message, never wall-clock, so the function stays pure.
3. **Canonicalize placement.** Every tool result is moved to sit immediately after its assistant message, in the assistant's declared `toolCalls` order. Anthropic and Bedrock flush the pending tool block when a non-tool message intervenes, so placement is not cosmetic.

The function is pure, deterministic, and idempotent: `repair(repair(x))` deep-equals `repair(x)`.

`prepareResumeMessages(checkpointMessages)` is the resume-path wrapper: it repairs the history and strips `system` messages (the prompt is rebuilt for the new run). Resume, replay, and cancellation histories all route through this repair, which is why a forked run no longer inherits a dangling pair from the run it forked.

Contrast with `removeDanglingMessages()`, which is still exported and still *deletes* the offending assistant messages. Use `repair` when you want to continue a conversation, `remove` when you only want a valid transcript.

## 8. Known Limitation: Usage Accounting

**Only the successful attempt's token usage is accounted.** A model call that throttles twice and succeeds on the third attempt records the usage of the third attempt only.

If the failed attempts consumed billable input tokens upstream, your Namzu-side cost figures will under-report relative to your provider invoice. The gap widens with `maxAttempts` and with how often the provider fails *after* ingesting the prompt. Treat SDK cost tracking as a budget guard rather than an accounting ledger, and reconcile against the provider's own usage reporting.

## 9. Common Mistakes

| Mistake | Consequence |
| --- | --- |
| Catching a bare `Error` and inspecting `.message` to detect rate limits | Brittle. Check `isProviderRequestError(err)` and branch on `err.kind` |
| Setting `maxAttempts` high to "be safe" | Attempts share the run deadline. A large cap on a short `timeoutMs` just spends the budget waiting |
| Assuming `retry.enabled: false` means zero retries anywhere | The main loop honors it; the ancillary paths in section 3 keep their own bounded retry |
| Expecting `agent.cancel()` to stop an in-flight Ollama non-streaming call | It cannot. Check `capabilities.supportsAbortSignal` |
| Reconciling provider invoices against SDK cost figures | Failed attempts are not accounted (section 8) |
| Calling `removeDanglingMessages()` before a resume | It deletes the assistant turns. `prepareResumeMessages()` heals them instead |

## Related

- [Run Configuration](./configuration.md)
- [Replay](./replay.md)
- [Low-Level Runtime](./low-level.md)
- [Provider Operations](../provider-integration/operations.md)
- [Providers Overview](../../providers/README.md)
- [Runtime Pipeline](../architecture/runtime-pipeline.md)
- [Migrating to 0.5.0](../../migration/0.5.md)
- [Provider Errors Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/provider/errors.ts)
- [Model-Call Retry Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/runtime/query/model-call.ts)
