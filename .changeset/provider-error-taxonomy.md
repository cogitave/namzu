---
'@namzu/sdk': minor
'@namzu/anthropic': patch
'@namzu/bedrock': patch
'@namzu/http': patch
'@namzu/lmstudio': patch
'@namzu/ollama': patch
'@namzu/openai': patch
'@namzu/openrouter': patch
---

Normalize request-start and mid-stream failures across all seven provider
drivers with the new public `ProviderRequestError` taxonomy. Errors expose
`kind` (`throttle`, `network`, `auth`, `context_overflow`, `bad_request`, or
`server`), `providerId`, and optional `status` / `retryAfterMs`, with
`isProviderRequestError` available for structural narrowing across package
copies.

Provider error messages and metadata deliberately omit vendor response bodies,
URLs, messages, and causes because upstream errors can echo credentials. HTTP
dialect-mismatch diagnostics now keep only the endpoint origin and status.
Caller-owned aborts remain unchanged instead of being reclassified.

The runtime preserves the classified error through streaming and publishes its
safe metadata as `Run.lastProviderError` and
`run_failed.providerError`. Bedrock stream-exception events and provider
iterator/SSE failures no longer appear as clean end-of-stream.

`retryAfterMs` is metadata only; this change does not add retries or alter vendor
SDK retry settings. Provider packages now require `@namzu/sdk >=1.3.0`, the
first SDK release containing these runtime helpers and types.

Ollama now maps `done_reason: "length"` truthfully so runtime continuation can
run. LM Studio treats content-free `contextLengthReached` as context overflow,
while preserving `"length"` after partial content, and creates its WebSocket
client lazily on first use.
