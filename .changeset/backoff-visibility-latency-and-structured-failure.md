---
'@namzu/sdk': minor
'@namzu/telemetry': patch
'@namzu/cli': patch
---

Four places where namzu knew something and told no one.

**A backoff is now visible.** `withProviderRetry` logged and slept. There
was no run event, no wire event, and — worse than that — the sole
production call site never passed a logger, and every warn in the decorator
is guarded behind it, so the log lines were dead code too. A run could sit
silent for the better part of a minute between `iteration_started` and the
next event, or up to the 60s server-directed cap, with no signal and no
keepalive: a backoff was indistinguishable from a hang, and a host's
watchdog would cancel a run that was about to succeed.

A `provider_retry` run event now carries the attempt, the ceiling, the
delay, the classified code and whether the server asked for it, mapped to
`provider.retry` on the SSE wire and to a `running` status update over A2A.
It is emitted **before** the sleep, so the delay it names is still ahead —
which is also why it rides the stream as a delta-less chunk rather than an
out-of-band callback: the consumer is blocked inside the provider's
iterator, so a callback could not reach it until the wait was already over.
The omission was never principled; `tool_progress` exists to answer "is it
still working?" and the wire contract justifies the reasoning events on
exactly the same grounds.

**Two latency measurements that could not be recovered from the data.**
`gen_ai.client.time_to_first_token` is recorded at the first delta of any
kind. namzu streams, so perceived latency is dominated by that number, and
the one existing latency histogram measures the whole request — it cannot
tell a fast-first-token long generation from a stalled one, and no host
could reconstruct the difference in any form.
`gen_ai.tool.call.duration` records what the executor has measured since
its first version: the value was already in scope one frame above the call
site, emitted per call on `tool_completed`, and had no instrument. It
carries the same attributes as the tool-call counter, so "which tool is
slow" and "which tool fails" are one query rather than two that cannot be
joined.

**`run_failed` carries the classification it always had.** The event was a
bare string, and the run boundary flattened the throwable into it,
discarding `code`, `status`, `retryAfterMs`, `retryable`, `details` and the
cause chain. This was never a missing taxonomy: the provider-boundary
classifier already walks all of that, so a fully-populated error arrived at
the boundary and was thrown away one line later — and `toPlatformError`,
the projection written for exactly this, had no callers outside its own
test. `run_failed` now carries `failure` alongside `error`; the A2A bridge
sends it as event metadata (a peer deciding whether to retry needs the
flag, not prose to pattern-match) and the CLI prefixes the code. Nothing
had to change at the hundreds of `throw` sites.

Not fixed, and worth naming: the advisory `on_error` trigger still
substring-matches. Its input is tool output from the message history, which
has no structured code to preserve — that needs a tool-side error catalog,
not this change.

**The published attribute constants can no longer drift.**
`@namzu/telemetry/attributes` restated the attribute bags by hand and had
already lost `GENAI.TOKEN_TYPE`, the dimension that splits the token
counter by kind. The consequence was narrow — namzu emits through the
canonical module, so the dimension is on the data regardless — but this is
the entry point the observability docs steer consumers to, the package had
no tests at all, and the public-surface verifier only loads the SDK bundle.
It is now a re-export, with a parity test so a future hand-copy fails
immediately.
