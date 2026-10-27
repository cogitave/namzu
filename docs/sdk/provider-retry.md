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
dropped the socket error it carried. A response stream that closes without the
provider's own end-of-response marker is reported by the driver as a network
failure of the same kind, so it is retried rather than accepted as a finished
answer. Every driver does this: a final finish reason on the OpenAI wire
(OpenAI, OpenRouter, DeepSeek, Zen on every wire, and servers reached through
`@namzu/http`), `message_stop` on the Anthropic wire, `done` for Ollama, a
terminal finish reason for Google, and a stop reason for LM Studio (a reply that
ends with none, or because the model failed or was unloaded, is cut). A certificate that fails verification (expired, self-signed, wrong host)
is a network failure that is not retried. An abort is never retried.

Two failures on the way to the provider are classified as `network` but are not
retried, because the same request meets the same obstacle again: a proxy that
answered the tunnel request with a refusal (a 407 asks for credentials) and a
certificate that does not chain to an authority the process trusts. They are
read off the failure's cause chain with `readTransportCause`, which returns
`'proxy_auth_required'`, `'proxy_refused'` or `'untrusted_certificate'`, and the
error catalog explains each in its own words (`provider.proxy_auth`,
`provider.proxy_refused`, `provider.untrusted_certificate`) instead of the
general `provider.network` advice. `ErrorFacts.transport` carries the same
value to a custom rule.

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
| `retryMidStream` | `false` | Also retry a stream that failed after it produced text. Off, such a failure ends the call, because the consumer has already seen the text. A stream that produced only reasoning, or only the start of a tool call, is retried whatever this says. |

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
showed it must drop it too.

A provider chain treats such pieces (reasoning, or a call still being written) as nothing produced: when a member spends its retries with only those, the chain moves on to the next member and the `fallback` notice carries `restart: true`, which the turn handles like a restarting retry. The `provider_fallback` session event carries the same `restart: true`, so a host that draws the reply as it streams drops what the failed member showed. Its `fromModel` is the model the request asked for when the head of the chain was declared without one, so a host can say which model failed.

A tool call that is still being written when the connection drops is restarted
too, whatever `retryMidStream` says, as long as no text has been shown: nothing
runs before the response is settled, so the half-written call is dropped on the
`restart` notice and the same request is sent again. The model never sees the
fragment. A stream in which a call finished (`toolCallEnd`), a hosted tool ran
or a finish reason arrived is never restarted, because that work is real; the
turn keeps what finished. When the tries are spent and no call came through
whole, the failure pauses the turn (see below), and a call cut off by the
connection reaches the model only as "the connection dropped, send the same call
again", with no size named. The output-limit advice is unchanged.

## The terminal's policy

The terminal chooses its own numbers (`packages/cli/src/provider-retry.ts`),
for the same failures:

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
than a minute, the reply pauses ("Paused. … Press Enter to continue, or Esc to
stop."), and a new message closes the pause.

A pause that came from a connection that would not hold (no connection, a reset,
a server fault) does not wait for you: "Paused. Namzu could not reach OpenAI.
Namzu tries again on its own. Press Enter to try now, or Esc to stop." A server
fault reads the same ("Paused. OpenAI is having problems on its side. Namzu tries
again on its own. …"). The reply
continues from its checkpoint after 15 seconds, then 30 seconds, 1, 2 and 5
minutes, and every 5 minutes after that, until it goes through; the hint line
counts down, Enter tries at once and Esc stops it. A try that cannot start
(the paused turn is gone, or no provider is ready yet) is followed by the next
step of the same schedule, so the pause never sits without a timer. Sending a
message or starting another conversation ends the run of tries. A rejected key, a rate limit
and a tool waiting for a person do not mend themselves and wait for you. A
certificate that fails verification is named as that and is not retried.
