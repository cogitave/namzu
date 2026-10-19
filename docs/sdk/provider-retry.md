---
type: Reference
title: Provider retry
description: How the kernel retries a model call that failed for a reason that may pass, the options that shape the wait, and the policy the terminal chooses.
resource: packages/sdk/src/provider/retry.ts
tags: [sdk, provider, retry, backoff, cli]
status: stable
generated: { by: process:claude-code, at: 2026-10-19T00:00:00Z }
---

# Provider retry

`withProviderRetry` wraps a provider so that a transient failure is tried again
before it reaches the turn. `query()` applies it to every chain member unless
`retry: false`. Which failures count is decided by the classification in
`types/provider/errors.ts`: a 429, 408, 5xx (including 503 and 529), a socket
reset, a DNS failure and a timeout are retryable; 400, 401, 403, 404 and a
context overflow are not. A response body the peer cut mid-stream (undici's
`TypeError: terminated`) counts as a socket reset, also when a vendor wrapper
dropped the socket error it carried. An abort is never retried.

## The options

`ProviderRetryConfig` (all optional through `query({ retry })` or a driver's
`retryDefaults`; the last one named wins):

| Option | Default | Meaning |
|---|---|---|
| `maxRetries` | `3` | Retries after the first try. `0` turns retrying off. |
| `initialDelayMs`, `maxDelayMs` | `500`, `16000` | The backoff doubles from the first to the cap. |
| `maxRetryAfterMs` | `60000` | A wait the provider names that is longer than this is not slept: the error is surfaced at once and the turn settles (it pauses, when the failure is recoverable). |
| `jitter` | `'full'` | `'full'` sleeps a random amount between zero and the step. `'proportional'` sleeps the step plus up to a quarter of it, never less. |
| `retryAfter` | `'exact'` | `'exact'` sleeps what `Retry-After` said. `'floor'` sleeps the longer of that and this attempt's backoff. |
| `retryMidStream` | `false` | Also retry a stream that failed after it produced text. Off, such a failure ends the call, because the consumer has already seen the text. A stream that produced only reasoning is retried whatever this says. |

A provider that sends `x-should-retry: false` is believed: the failure is not
retried whatever its status. `true` is not acted on, because a retryable status
is already retried. Drivers read the header into `ProviderRequestError.shouldRetry`
through `providerHttpError({ shouldRetry })` or `providerVendorError`.

## Telling the consumer

Before each sleep the decorator yields a chunk with `retry: { attempt,
maxRetries, delayMs, code, status?, serverDirected, restart? }`, which the
turn turns into a `provider_retry` session event (and `provider.retry` on the SSE
wire). `attempt` is the try that just failed, counted from 1.

A stream that fails after yielding only reasoning (no text, tool call, hosted
tool or citation yet) is retried like one that failed before its first chunk:
same backoff, same notice, and the notice carries `restart: true` so a host that
showed the thinking drops it. This needs no option. The turn keeps reasoning
blocks by index and clears them on a restart, so the answer carries the second
attempt's reasoning once, never both. The terminal shows reasoning only as a
live indicator, so nothing it printed needs taking back, including under
`namzu exec` and `--json`.

With `retryMidStream`, a stream that produced output and then failed is
restarted from the beginning and the notice carries `restart: true`. Whatever
that attempt produced is void: the turn drops its own copy and a host that
showed it must drop it too. A stream that has begun a tool call, or a hosted
tool, is never restarted, because the call may already be under way.

## The terminal's policy

The terminal chooses its own numbers (`packages/cli/src/provider-retry.ts`),
following the reference terminal's behaviour for the same failures:

- ten retries (eleven tries in all);
- a wait that starts at half a second and doubles to thirty-two, with up to a
  quarter added on top (`jitter: 'proportional'`);
- a named `Retry-After` is a minimum, not the whole answer (`retryAfter: 'floor'`);
- a provider that asks for more than a minute is not waited for;
- from the interactive screen, a stream that dies after some text starts over
  (`retryMidStream`); `namzu exec`, `--json` and scheduled runs write to a pipe
  that cannot take text back, so they keep the old rule.

The OpenAI, Codex and DeepSeek drivers sit on a vendor SDK that retries twice by
itself and out of sight. The terminal builds them with `maxRetries: 0`, so a
failed request is counted and shown once.

The SDK's own defaults are unchanged; a host that wants the terminal's numbers
passes them in `query({ retry })`.

## What the person sees

The Working row carries one line while a retry is waited out: a red bullet, what
failed, and a dim `Retrying in 5s · attempt 2/10` that counts down. The first
two tries of a plain server fault say only "The request failed."; from the third
(or at once for no connection or a rate limit) the line names the provider and
the cause in plain words. Esc during the wait interrupts the turn as it does at
any other time. When the tries run out, or the provider asks for a wait longer
than a minute, the reply pauses ("Paused: … Press Enter to try again, or type a
new message."), and a new message closes the pause.
