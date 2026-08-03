---
'@namzu/sdk': minor
---

Add a provider failure taxonomy and retry transient model-call failures.

No driver in the estate retried anything: a single `429`, `503` or dropped
socket terminated the run. Nor could one be added, because every driver threw
its vendor SDK's raw error and the runtime had no way to tell a rate limit
from a malformed request — classification is the substrate a retry policy
stands on.

`ProviderError` gives failures a `code` (`rate_limit`, `overloaded`,
`server_error`, `timeout`, `network`, `auth`, `invalid_request`,
`context_length_exceeded`, `content_filter`, `not_found`, `unknown`), a
`retryable` flag, the HTTP `status`, and a server-directed `retryAfterMs`
parsed from `Retry-After` (both delta-seconds and HTTP-date forms).
`classifyProviderError` derives it from status, then transport errno, then
message text — so a window overflow arriving as a `400` is filed as
`context_length_exceeded` rather than a generic invalid request, because the
caller can act on one and not the other.

`withProviderRetry` wraps any `LLMProvider` with exponential backoff and full
jitter, honouring `Retry-After` up to a sanity cap. It retries **only before
the first content chunk**: once a delta has been yielded the consumer has
already emitted `text_delta` events, so restarting would duplicate output.
Aborts propagate untouched, so a Stop still settles the run as `cancelled`.

`query()` wraps its provider by default; pass `retry: false` to opt out, or a
partial config to tune it. The wrapper is transparent to `id`, `name` and
`capabilities`, so capability negotiation is unaffected.
