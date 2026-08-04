---
'@namzu/sdk': patch
---

A driver that classified its own failure was being punished for it, in two
places, and both shipped in 5.0.0.

**`classifyProviderError` never read `kind`.** A `ProviderRequestError` — the
type first-party drivers throw when they have diagnosed a failure themselves —
fell through to the status heuristics, where a carefully-determined
`context_overflow` carrying a 400 became `invalid_request`. Three of the six
kinds landed wrong that way:

| kind | was | now |
|---|---|---|
| `context_overflow` | `invalid_request`, not retryable | `context_length_exceeded`, not retryable |
| `server` | `invalid_request`, not retryable | `server_error`, **retryable** |
| `network` | `invalid_request`, not retryable | `network`, **retryable** |

The overflow case was not cosmetic. The run loop reaches for compaction when it
sees `context_length_exceeded`, so relief — the one provider failure this
kernel can actually do something about — was unreachable for exactly the
drivers that had diagnosed the problem correctly.

**`withProviderRetry` rethrew such errors before the retry loop.** Its comment
justified preserving the driver's classification, which is right; the code also
skipped retrying, which is a separate decision nobody made. A first-party HTTP
or OpenRouter driver reporting a 429 as `kind: 'throttle'` got exactly one
attempt, while the identical failure from a driver that classified nothing got
the full backoff.

Retry is now decided the same way for both, from the classification's
`retryable`. The original error still escapes to the run boundary, so
`run.lastProviderError` keeps reporting the driver's own
`{ kind, status, retryAfterMs }` — wrapping there would have fixed the retry
and lost the vendor's `kind`, which the existing stream-recovery test caught.

**What changes for you.** A 429, a 5xx or a socket failure from
`@namzu/http` or `@namzu/openrouter` is now retried with backoff instead of
failing on the first attempt, and a context overflow from those drivers now
triggers compaction instead of failing the run. If you were relying on a typed
error failing fast, `retry: { maxRetries: 0 }` on `drainQuery` restores that.
