---
"@namzu/sdk": patch
---

A model call whose stream was cut (a connection reset, `terminated`) after sending only reasoning, and before any text or tool call, is now retried like a failure before the first chunk, with the same backoff and `provider_retry` notice. Before, it failed the turn. The notice carries `restart: true`, so a host that showed the thinking drops it; the turn already replaces it, so the answer holds the second attempt's reasoning once. Nothing to do to take this: it needs no option, and `retryMidStream` still governs only a stream that had produced text. A stream that had begun a tool call is still never retried. A caller that relied on a reasoning-only cut surfacing as an error on the first failure will now see one or more `provider_retry` notices before the error.
